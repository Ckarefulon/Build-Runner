/**
 * Minimal GitHub REST client for Build-Runner.
 *
 * Uses global fetch (Node >= 20). Every call carries the GitHub API version
 * header so behaviour never drifts with the API's default.
 */

const API = 'https://api.github.com'
const API_VERSION = '2022-11-28'

export class GitHubError extends Error {
  constructor(message, { status, body, url } = {}) {
    super(message)
    this.name = 'GitHubError'
    this.status = status
    this.body = body
    this.url = url
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * @param {object} options
 * @param {string} options.token     GitHub token (repo + workflow scopes)
 * @param {string} [options.baseUrl] override for GitHub Enterprise
 */
export function createClient({ token, baseUrl = API } = {}) {
  if (typeof token !== 'string' || token.trim() === '') {
    throw new Error(
      '缺少 GitHub token。请设置环境变量 BUILD_RUNNER_TOKEN（需要 repo + workflow 权限）。'
    )
  }

  async function request(method, path, { body, raw = false, redirect = 'follow', accept } = {}) {
    const url = path.startsWith('http') ? path : `${baseUrl}${path}`
    const headers = {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'build-runner-mcp',
      'X-GitHub-Api-Version': API_VERSION,
      Accept: accept ?? (raw ? '*/*' : 'application/vnd.github+json'),
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    // Retry only on the statuses GitHub actually uses for transient trouble.
    let lastError
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response
      try {
        response = await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect,
        })
      } catch (error) {
        lastError = new GitHubError(`请求 GitHub 失败：${error.message}`, { url })
        await sleep(400 * (attempt + 1))
        continue
      }

      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        const retryAfter = Number(response.headers.get('retry-after'))
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 800 * (attempt + 1))
        lastError = new GitHubError(`GitHub 返回 ${response.status}`, { status: response.status, url })
        continue
      }

      if (raw) {
        if (!response.ok && response.status !== 302) {
          const text = await response.text().catch(() => '')
          throw new GitHubError(`GitHub 返回 ${response.status}：${text.slice(0, 300)}`, {
            status: response.status,
            body: text,
            url,
          })
        }
        return Buffer.from(await response.arrayBuffer())
      }

      const text = await response.text()
      let parsed = null
      if (text !== '') {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = text
        }
      }
      if (!response.ok) {
        const message = parsed && typeof parsed === 'object' && parsed.message ? parsed.message : text
        throw new GitHubError(`GitHub 返回 ${response.status}：${String(message).slice(0, 300)}`, {
          status: response.status,
          body: parsed,
          url,
        })
      }
      return parsed
    }
    throw lastError ?? new GitHubError('请求 GitHub 失败', { url })
  }

  return {
    request,
    getUser: () => request('GET', '/user'),

    getRepo: (owner, repo) => request('GET', `/repos/${owner}/${repo}`),

    getBranch: (owner, repo, branch) =>
      request('GET', `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`),

    getWorkflow: (owner, repo, file) =>
      request('GET', `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(file)}`),

    /** Fire a workflow_dispatch. GitHub answers 204 with no run id. */
    dispatch: (owner, repo, file, { ref, inputs }) =>
      request('POST', `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(file)}/dispatches`, {
        body: { ref, inputs: inputs ?? {} },
      }),

    listRuns: (owner, repo, { workflow, branch, createdAfter, perPage = 30 } = {}) => {
      const params = new URLSearchParams({ per_page: String(perPage) })
      if (workflow) params.set('workflow_id', workflow)
      if (branch) params.set('branch', branch)
      if (createdAfter) params.set('created', `>=${createdAfter}`)
      return request('GET', `/repos/${owner}/${repo}/actions/runs?${params}`)
    },

    getRun: (owner, repo, runId) => request('GET', `/repos/${owner}/${repo}/actions/runs/${runId}`),

    getRunJobs: (owner, repo, runId) =>
      request('GET', `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`),

    cancelRun: (owner, repo, runId) =>
      request('POST', `/repos/${owner}/${repo}/actions/runs/${runId}/cancel`),

    /** Raw job log (may be an HTML error page on GitHub's side; caller checks). */
    getJobLog: (owner, repo, jobId) =>
      request('GET', `/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, { raw: true }),

    listArtifacts: (owner, repo, runId) =>
      request('GET', `/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`),

    getArtifactDownload: (owner, repo, artifactId) =>
      request('GET', `/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`, {
        raw: true,
        redirect: 'follow',
      }),

    createCommitStatus: (owner, repo, sha, { state, context, description }) =>
      request('POST', `/repos/${owner}/${repo}/statuses/${sha}`, {
        body: { state, context, description },
      }),

    /** Read a file's contents from a branch. Returns { sha, text } or null. */
    async getFile(owner, repo, path, ref) {
      try {
        const data = await request(
          'GET',
          `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`
        )
        if (Array.isArray(data) || !data || data.type !== 'file') return null
        return { sha: data.sha, text: Buffer.from(data.content ?? '', 'base64').toString('utf8') }
      } catch (error) {
        if (error instanceof GitHubError && error.status === 404) return null
        throw error
      }
    },

    /** Create or update a file on a branch — used to publish workspaces. */
    async putFile(owner, repo, path, { text, message, branch, sha }) {
      return request(
        'PUT',
        `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
        {
          body: {
            message,
            content: Buffer.from(text, 'utf8').toString('base64'),
            branch,
            ...(sha ? { sha } : {}),
          },
        }
      )
    },

    async ensureBranch(owner, repo, branch, fromBranch) {
      try {
        await request('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`)
        return { created: false }
      } catch (error) {
        if (!(error instanceof GitHubError) || error.status !== 404) throw error
      }
      const base = await request('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(fromBranch)}`)
      await request('POST', `/repos/${owner}/${repo}/git/refs`, {
        body: { ref: `refs/heads/${branch}`, sha: base.object.sha },
      })
      return { created: true, sha: base.object.sha }
    },

    /**
     * Delete every file under a branch directory prefix. Used to reset the
     * workspace branch so a later run cannot see stale files from an earlier
     * one — otherwise "works in my AI session" stops meaning anything.
     */
    async clearDirectory(owner, repo, dir, branch, message) {
      let removed = 0
      let guard = 0
      for (;;) {
        guard += 1
        if (guard > 100) break
        const entries = await request(
          'GET',
          `/repos/${owner}/${repo}/contents/${dir}?ref=${encodeURIComponent(branch)}`
        ).catch(error => {
          if (error instanceof GitHubError && error.status === 404) return []
          throw error
        })
        const files = (Array.isArray(entries) ? entries : []).filter(item => item.type === 'file')
        if (files.length === 0) break
        for (const file of files) {
          await request('DELETE', `/repos/${owner}/${repo}/contents/${file.path}`, {
            body: { message, sha: file.sha, branch },
          })
          removed += 1
        }
      }
      return removed
    },
  }
}

/** Parse `owner/name` or a full GitHub URL into { owner, repo }. */
export function parseSlug(slug) {
  const value = String(slug ?? '').trim()
  if (value === '') return null
  const urlMatch = value.match(/github\.com[/:]([^/]+)\/([^/#?]+)/i)
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2].replace(/\.git$/i, '') }
  }
  const parts = value.split('/')
  if (parts.length === 2 && parts[0] !== '' && parts[1] !== '') {
    return { owner: parts[0], repo: parts[1].replace(/\.git$/i, '') }
  }
  return null
}
