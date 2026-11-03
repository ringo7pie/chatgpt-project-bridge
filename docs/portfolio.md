# ChatGPT Project Bridge: portfolio notes

A local MCP server that lets ChatGPT read the projects on my PCs, and hand approved coding work to Claude Code, under rules the PC enforces.
This page explains the problem, the decisions that shaped the design, and what was measured.
For installation and the full manual, see the [README](../README.md) and the Japanese [README.ja.md](../README.ja.md).

## The problem

I use ChatGPT to think through designs and Claude Code to implement them, across nine projects on a Windows PC and an Ubuntu PC (games, local AI tooling, a translator fork, terminal settings).
Pasting files into ChatGPT was slow, quickly out of date, and leaked more than I meant to share.
I wanted ChatGPT to ask for exactly what it needs, at the moment it needs it, and I wanted the PC, not the chat, to decide what it may see.

Constraints that shaped everything:

- **No inbound ports and no cloud copy of the code.** OpenAI's Secure MCP Tunnel lets a local client hold an outbound connection, so the MCP server never faces the internet.
- **ChatGPT, or anyone who can edit a repository, must not be able to widen its own access.** That includes Claude Code, which edits the same working tree.
- **Two operating systems, one behavior.** The same `server.mjs` runs on Windows and Ubuntu. The admin tools are native to each.
- **No dependency tree to audit.** Node.js built-ins only, and pinned, verified downloads for the two external binaries.

## Design decisions

### 1. Approve a fingerprint, not a file

Each project has a `.chatgpt-project-bridge.json` that lists what may be read.
That file lives in the repository, so it cannot be the source of trust: a commit, a merge, or Claude Code itself could change it.
The server normalizes the whole exposure (allowlist, deny list, Git and source opt-ins, Claude Code settings), hashes it with SHA-256, and compares it with an approval stored in the user profile.
On a mismatch every tool refuses, including the ones that were fine before. The CLI and GUI show the normalized exposure and its fingerprint, and the user approves exactly what they read.

New settings join the fingerprint only when present, so no upgrade since 2.5.0 has invalidated an existing approval: projects that do not use a new key keep their old fingerprint.

### 2. Read-only by construction, then one narrow write path

The 25 read tools (documents, Git, analysis, source search) cannot write, delete, or execute.
The source-reading modules do not import `fs` or `child_process` at all, and a self-test checks that statically.
Git runs only through an allowlist of read subcommands, after `.git/config` has been checked for keys that could run a program (`core.fsmonitor`, `core.hooksPath`, filters, aliases, and so on).

Search is a streaming Node.js implementation instead of ripgrep.
ripgrep opens files by itself, so the bridge could not apply its own checks (pinned file descriptors, hardlink detection, per-line secret masking) to what it reads.
It is slower, and that cost is measured below.

### 3. Claude Code jobs with the smallest useful permissions

2.7.0 added the only tools that change anything: ChatGPT can start `claude -p` in a project whose `claudeCode` setting the user approved.

- `--permission-mode dontAsk --permission-prompts none`: anything not pre-approved is denied, never asked.
- `--setting-sources user` plus a generated `--settings` file: the user's own hooks stay active, but the project's `.claude/` settings are ignored, because Claude Code could rewrite them.
- The deny rules mirror the bridge's never-read set, so Claude Code cannot read what ChatGPT is not allowed to see.
- `allowedCommands` patterns are validated when the configuration is read: no shells, relays, network tools, privilege escalation, or Git write subcommands.
- Not used, on purpose: `--bg` and `-w` (a worktree session can push and open a draft PR on exit), `acceptEdits` (it also auto-approves `rm` and `mv`), `bypassPermissions`, and `--bare` (it would drop the subscription login).
- The environment is an allowlist, so the tunnel key and `ANTHROPIC_API_KEY` never reach the child process.

2.9.0 turned this into a loop: ChatGPT reads `get_claude_code_settings`, writes a plan, shows it to the user, starts the job, reviews the result with `get_git_diff`, and continues the same session with `continueJobId` if the diff does not match the plan.
2.10.0 lets ChatGPT pick the model and effort per job, from a fixed list in code, so no new setting (and no new approval) was needed.

### 4. Setting and approving are one operation

The 2.8.0 GUI switches "source reading" and "Claude Code" per project.
Writing the setting first and approving second leaves a gap: if the user cancels the approval dialog, the project is now unapproved and silently disappears from ChatGPT.
`SetPermission` instead computes the new exposure without writing anything, and writes the setting and the approval together only when it receives the fingerprint the user approved, restoring the file if anything fails.

The transformation lives in one Node.js module that both the PowerShell CLI and the Python CLI call, so the two admin tools cannot drift apart.

### 5. Verified supply chain

The installers download exactly two things, the Tunnel Client and Node.js, at versions pinned in `dependencies.lock.json` with their SHA-256.
The maintainer command that updates the lock refuses a Tunnel Client release unless `gh attestation verify` accepts its SLSA provenance for every asset.
Bundles list every file in `SHA256SUMS.txt` and can be signed with `ssh-keygen -Y sign`.

## Numbers

| | |
|---|---|
| Tools | 31 in hub mode (25 read-only, 6 for Claude Code jobs, of which 4 are read-only) |
| Code | about 26,000 lines of product code and 14,500 lines of self-tests |
| Self-test checks | about 1,250 on Windows across 12 suites, plus the Linux-only suites (relay, GTK GUI, end-to-end workflow) |
| npm dependencies | 0 |
| Platforms | Windows 11 (PowerShell 7, Windows Forms) and Ubuntu 24.04 (Python 3, GTK 3), one shared server |

Measured on a real game project (Windows, Node.js 24, over 20,000 files including dependencies and two submodules):

| Operation | Time |
|---|---|
| Default scope after exclusions | 1,448 files, about 35 MB |
| List every page of files | about 0.5 s |
| Fixed-string search over the whole scope | about 1.9 s (3.8 s without the prefilter) |
| Regular-expression search over the whole scope | about 4.6 s |
| Read lines from the middle of a 335 KB, 4,530-line file | a few milliseconds |
| List 22,000 test logs, newest first | about 2.3 s |

End-to-end checks with the real Claude Code, through the same JSON-RPC that ChatGPT sends, in a throwaway repository:
2.10.0 ran four jobs (haiku with low effort, a follow-up that switched to sonnet and inherited the effort, fable with xhigh, and haiku with xhigh) for an estimated 0.36 USD in total, and all 19 checks passed. The result was judged from the files and the Git state, not from Claude Code's own report.
The same day, a request from ChatGPT ("use Fable 5.1 with xhigh") produced a job that finished in 48 seconds with a one-line diff.

## Bugs the tests caught

- The final response mask treated a JSON key named `secret` as a secret and replaced its value, which broke the JSON. Rule since then: no response key may be named like a secret.
- A depth-first scan let one huge third-party icon folder use up the entry limit, so `src` and `tests` were never reached. The scan is breadth-first now.
- Git writes `core.worktree` into a submodule's own config, and the safety check flagged every normal submodule. That value is now allowed only when it points at the submodule's own working tree.
- A file that merely had a variable called `_process_token` was classified as a secret store. Only quoted assignments count now.

## History

| Version | Date | Change |
|---|---|---|
| 2.2.x, 2.3.0 | to 2026-10-08 | Hub mode (one tunnel, many projects); admin GUI for Windows and Ubuntu |
| 2.4.0 to 2.4.3 | 2026-10-10 to 2026-10-11 | Save-on-exit snapshots and a relay; an audit by Claude Code; auto-start after reboot |
| 2.5.0 | 2026-10-19 | 10 read tools for Git and project analysis |
| 2.6.0 | 2026-10-25 | 6 source-reading tools |
| 2.7.0 to 2.9.0 | 2026-10-25 | Claude Code jobs, GUI permission switching, the plan-to-implementation flow |
| 2.10.0 | 2026-11-03 | Model and effort per job |
| 2.10.1 | 2026-11-03 | Public release: English README, license, CI, anonymized docs |

## How it was built

2.4.0 was produced by ChatGPT.
From 2.4.1 on, Claude Code audited the code and implemented each release from a plan that I reviewed.
I decided the scope and every security trade-off, and each release records the facts checked before the change, the decisions, and the verification in [the changelog](../references/CHANGELOG-2.4.0.md).

## What I would do next

- Handle requests concurrently, so a slow search does not hold up a quick status call.
- A language-aware `find_references` (today it is text matching).
- Inspect approval-file ACLs on Windows, as is already done for file modes on Linux.
- Publish signed bundles together with the signing key.
- macOS support.
