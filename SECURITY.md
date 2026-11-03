# Security policy

ChatGPT Project Bridge exposes parts of a local disk to a cloud service, and can let that service start Claude Code on the PC.
This page states what the bridge is designed to guarantee, what it deliberately does not protect against, and how to report a problem.
The Japanese manual ([README.ja.md](README.ja.md) and [references/setup.md](references/setup.md)) has the full details.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** for this repository (the "Security" tab, then "Report a vulnerability").
Do not open a public issue for a vulnerability, and do not include real tokens, keys, or private file contents in the report.
This is a personal project maintained on a best-effort basis, so there is no guaranteed response time.

Only the latest release is supported.

## Design guarantees

These are enforced in code and covered by the self-tests in `scripts/`.

**Approval**

- Each project's exposure (allowed files and directories, deny list, Git and detail opt-ins, source scope, Claude Code settings) is normalized and hashed with SHA-256.
- The approval is stored outside the project (`%APPDATA%\chatgpt-project-bridge\approvals\` on Windows, `$XDG_CONFIG_HOME/chatgpt-project-bridge/approvals/` with mode 0600 on Ubuntu).
- Every tool call is refused unless the current fingerprint matches the approval. Editing the project's `.chatgpt-project-bridge.json` therefore unexposes the project until the user approves again.
- On Linux, an approval file that is a symlink, not owned by the user, or writable by group or other is treated as missing.

**Reading**

- Sensitive names are always refused, whatever the allowlist says: `.env*`, `*.pem`, `*.key`, `*.pfx`, `*.p12`, `*.ppk`, `id_rsa*` and similar, `*.kdbx`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, names containing `credential` or `secret`, and everything under `.git`, `.ssh`, `.aws`, `.azure`, `.gnupg`, `.kube`.
- Files containing NUL bytes are not served. Source files that look like secret stores (a PEM private key, several `KEY=value` lines) are refused as a whole.
- Every response is masked for tokens, passwords, and private key blocks. Source text and logs are also masked for e-mail addresses and user folder names, line by line, without changing line numbers. Code search runs on the masked text, so a secret cannot be guessed through search results.
- Symbolic links, junctions, and hardlinks are not followed, in any path component.
- Names with control, bidirectional, or invisible characters make the whole configuration invalid, so an approval dialog cannot be spoofed.
- Text read from files is data. The tool descriptions tell ChatGPT never to treat it as instructions.

**Git**

- Before any Git command, `.git/config` (local and worktree scope) is checked for keys that can run programs (`core.fsmonitor`, `core.hooksPath`, `core.sshCommand`, `filter.*`, `alias.*`, and others). If one is present, no Git command runs for that project.
- Only read-only Git subcommands from a fixed allowlist are run. On Windows, Git is started by absolute path only.
- File names, commit subjects, branch names, and diff excerpts are hidden unless the user opted in.

**Claude Code jobs** (only for projects whose `claudeCode` setting the user approved)

- `claude -p` runs with `--permission-mode dontAsk --permission-prompts none --setting-sources user` and a generated settings file. Its deny rules mirror the bridge's never-read set and the project's `denyDirectories`.
- Only the commands in `claudeCode.allowedCommands` may run without confirmation. Patterns that start with a shell, a relay, a network tool, or privilege escalation, Git write subcommands, and Git's `-c` and `-C` options are rejected when the configuration is read.
- The child process receives an allowlisted environment. The Tunnel Client key, `ANTHROPIC_API_KEY`, and variables whose names contain token or password are never passed.
- One running job per project and two per PC. Each job has a time limit (1 to 180 minutes).
- The `model` and `effort` arguments accept only a fixed list of values, and are validated before anything is written or started.

**Installers**

- The installers download only the Tunnel Client and Node.js versions pinned in `dependencies.lock.json` and check their SHA-256. A Tunnel Client release is pinned only after `gh attestation verify` accepts its SLSA provenance.
- They never create projects, keys, tunnels, approvals, scheduled tasks, or startup entries.

## What the bridge does not protect against

- **An allowlisted command that runs a project script.** If `allowedCommands` contains something like `node scripts/*.mjs`, Claude Code can rewrite that script and then run it, which is arbitrary code execution inside the project.
- **Read-only commands in Claude Code.** Claude Code runs commands such as `cat` and `grep` without confirmation. A recursive `grep` can read files that the deny rules name, although the bridge never returns the raw output.
- **Prompt injection.** Instructions hidden in source, documents, or logs can still influence ChatGPT, and through it the text of a job's prompt. Read the plan in the chat before you approve a job.
- **Software running as the same user.** On Windows the approval file's ACL is not inspected, so a program running as the same user can rewrite it.
- **Network shares.** On a UNC path or a mapped drive, the file server follows its own symbolic links and the bridge cannot see them. The CLI warns about this but does not stop.
- **Secret masking is not perfect.** It is a last line of defense. Do not allow documents that contain secrets.
- **Hub mode widens the blast radius.** Any chat that uses the ChatGPT app can read every approved project on that hub. Keep projects of different sensitivity in separate tunnels.

## Emergency stop

- Cancel one job with `cancel_claude_job`.
- Stop the hub, which also stops running jobs: `project-bridge.ps1 -Action HubStop` on Windows, `systemctl --user stop chatgpt-project-bridge-hub.service` on Ubuntu.
- Set `claudeCode.enabled` to `false`, or remove a project from the hub, and approve again.
