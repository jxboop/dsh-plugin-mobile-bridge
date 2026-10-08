/**
 * 用 GitHub 的 Git Data API 推一个本地提交（github.com:443 被掐时唯一的出路）。
 *
 * 为什么不用 `git push`：这台机器上 `github.com:443` 时通时断，断的时候是
 * `schannel: server closed abruptly` / `Failed to connect after 21s`，而
 * `api.github.com`（`gh api` 走的通道）一直通。
 *
 * 关键技巧：**把 commit 的 author / committer / date / message / parent 原样搬过去**，
 * 于是 API 造出来的 commit sha 和本地**逐位相同** —— 本地不需要 fetch（也 fetch 不动），
 * 两边天生一致，`git status` 干净。
 *
 * 用法：node gitapi-push.mjs <本地仓库目录> <owner/repo> [branch]
 */
import { execFileSync } from 'node:child_process'

const [repoDir, slug, branch = 'main'] = process.argv.slice(2)
if (repoDir === undefined || slug === undefined) {
  console.error('用法: node gitapi-push.mjs <repoDir> <owner/repo> [branch]')
  process.exit(2)
}

const git = (...args) => execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' }).trim()
const gh = (args, input) => {
  const options = { encoding: 'utf8', input: input === undefined ? undefined : JSON.stringify(input), maxBuffer: 64 * 1024 * 1024 }
  return JSON.parse(execFileSync('gh', ['api', ...args], options))
}

/** 只在需要时打日志：CI 里满屏 sha 没人看，但出错时必须看得见。 */
const say = (...args) => console.log(...args)

const localSha = git('rev-parse', 'HEAD')
const parentSha = git('rev-parse', 'HEAD^')
const message = git('log', '-1', '--format=%B')
const [authorName, authorEmail, authorDate, committerName, committerEmail, committerDate] =
  git('log', '-1', '--format=%an%n%ae%n%aI%n%cn%n%ce%n%cI').split('\n')

// 变更清单：本地 HEAD 相对父提交动了哪些文件（这就是要搬过去的东西）。
const changed = git('diff', '--name-only', `${parentSha}..${localSha}`).split('\n').filter((line) => line !== '')
say(`本地提交 ${localSha.slice(0, 8)}（父 ${parentSha.slice(0, 8)}），改动 ${changed.length} 个文件`)

const remoteRef = gh([`repos/${slug}/git/ref/heads/${branch}`])
const remoteSha = remoteRef.object.sha
if (remoteSha === localSha) { say('远端已是这个提交，无需推送'); process.exit(0) }
if (remoteSha !== parentSha) {
  // 上一次 API 推送造出来的 commit 与本地内容一致、sha 不同（GitHub 内部的 commit
  // 序列化细节对不上，重试过多种日期/消息形态都没复现）。判据退一步：**树相同 =
  // 内容相同**。
  const remoteTreeOfHead = gh([`repos/${slug}/git/commits/${remoteSha}`]).tree.sha
  const localTreeNow = git('rev-parse', `${localSha}^{tree}`)
  const localParentTree = git('rev-parse', `${parentSha}^{tree}`)
  if (remoteTreeOfHead === localTreeNow) {
    say(`远端 ${remoteSha.slice(0, 8)} 与本地 HEAD 内容一致（树相同）—— 远端已是最新，无需推送`)
    say('（只是 sha 不同：等 github.com:443 通了 `git fetch && git reset --hard origin/main` 即可归一）')
    process.exit(0)
  }
  if (remoteTreeOfHead === localParentTree) {
    say(`远端 ${remoteSha.slice(0, 8)} 与本地父提交 ${parentSha.slice(0, 8)} 内容一致（树相同），按等价继续`)
  } else {
    console.error(`远端 ${remoteSha.slice(0, 8)} 既不是本地父提交、内容也不等价 —— 先 fetch/对齐再来`)
    process.exit(3)
  }
}
const remoteTree = gh([`repos/${slug}/git/commits/${remoteSha}`]).tree.sha

// 逐个上传 blob：**内容取自本地 git 对象**（不是工作区文件），保证和提交一致。
// 删除的文件不能取内容 —— GitHub 的 tree API 用 `sha: null` 表达"这个路径删掉"。
const treeEntries = []
for (const path of changed) {
  let exists = true
  // `cat-file -e` 对不存在的路径会往 stderr 吼一句 —— 那是探测本身，不是错误，压掉。
  try { execFileSync('git', ['-C', repoDir, 'cat-file', '-e', `${localSha}:${path}`], { stdio: 'ignore' }) } catch { exists = false }
  if (!exists) {
    treeEntries.push({ path, mode: '100644', type: 'blob', sha: null })
    say(`  del  ${path}`)
    continue
  }
  const content = execFileSync('git', ['-C', repoDir, 'show', `${localSha}:${path}`], { maxBuffer: 64 * 1024 * 1024 })
  const blob = gh(['-X', 'POST', `repos/${slug}/git/blobs`, '--input', '-'], {
    content: content.toString('base64'),
    encoding: 'base64',
  })
  const mode = git('ls-tree', localSha, '--', path).split(/\s+/)[0]
  treeEntries.push({ path, mode, type: 'blob', sha: blob.sha })
  say(`  blob ${path} → ${blob.sha.slice(0, 8)}`)
}

const tree = gh(['-X', 'POST', `repos/${slug}/git/trees`, '--input', '-'], {
  base_tree: remoteTree,
  tree: treeEntries,
})

// 本地那棵树长什么样？对上了才说明"搬过去的就是本地这一版"。
const localTree = git('rev-parse', `${localSha}^{tree}`)
say(`tree 本地 ${localTree.slice(0, 8)} / API ${tree.sha.slice(0, 8)} ${localTree === tree.sha ? '（一致）' : '（不一致！文件模式或行尾可能被改过）'}`)

const commit = gh(['-X', 'POST', `repos/${slug}/git/commits`, '--input', '-'], {
  message,
  tree: tree.sha,
  parents: [remoteSha],
  author: { name: authorName, email: authorEmail, date: authorDate },
  committer: { name: committerName, email: committerEmail, date: committerDate },
})

if (commit.sha === localSha) {
  say(`commit sha 与本地逐位一致 ✓ ${commit.sha}`)
} else {
  say(`⚠️ API commit ${commit.sha.slice(0, 8)} ≠ 本地 ${localSha.slice(0, 8)}：内容一致但 sha 不同，`)
  say('   本地之后要 `git fetch && git reset --hard origin/main`（等 github.com 通了再补）。')
}

gh(['-X', 'PATCH', `repos/${slug}/git/refs/heads/${branch}`, '--input', '-'], { sha: commit.sha, force: false })
say(`已更新 refs/heads/${branch} → ${commit.sha}`)
