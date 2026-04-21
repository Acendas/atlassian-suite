---
name: Jira Issue Attachments
description: This skill should be used when the user asks to "list jira attachments", "show attachments on jira issue", "download jira attachment", "save jira attachment", "view jira attachment", "upload file to jira", "attach file to jira issue", "delete jira attachment", or runs `/atlassian-suite:jira-attachment`. Lists, downloads, uploads, and deletes attachments on a Jira issue. Downloads stream straight to disk — safe for multi-GB files.
argument-hint: "<issue-key> [action: list|download|upload|delete] [attachment-id-or-save-path-or-file-path]"
allowed-tools: mcp__acendas-atlassian__jira_list_issue_attachments, mcp__acendas-atlassian__jira_get_attachment, mcp__acendas-atlassian__jira_download_attachment, mcp__acendas-atlassian__jira_add_attachment, mcp__acendas-atlassian__jira_delete_attachment, mcp__acendas-atlassian__jira_get_issue
---

# Jira Issue Attachments

## Inputs

`$1` = Issue key (e.g. `PROJ-123`) or numeric id.
`$2` = Action: `list` (default), `download`, `upload`, or `delete`.
`$3` = For `download` → save path (file OR directory — if directory, the attachment's original filename is appended).
        For `upload` → absolute local file path.
        For `delete` → attachment id.

## Steps

1. Resolve the issue key from `$1`. If the user only gave a summary, use `jira_search` with JQL first to find the key.

2. Dispatch on `$2`:

   - **`list`** → `jira_list_issue_attachments(issue_key)`. Returns `{count, attachments: [...]}`. Render each attachment as a compact table row: `id  filename  size(KB)  mimeType  author.displayName  created`. Sort by created desc.

   - **`download`** → two sub-cases:
     - Single attachment: run `list` first, ask the user which id they want (or use the only one if count=1). Then call `jira_download_attachment(attachment_id, save_path=$3)`.
     - All attachments: loop over list and call `jira_download_attachment` per entry, passing `save_path` as a directory. Report each with filename + bytes written.
     - Default save path when user doesn't supply one: `./jira-attachments/<ISSUE-KEY>/`.

   - **`upload`** → `jira_add_attachment(issue_key, file_path=$3, [filename])`. Confirm the file exists locally before calling. If the user supplies a custom filename via prompt, pass it through.

   - **`delete`** → **always confirm with the user first** — this is destructive and Jira has no trash. Then call `jira_delete_attachment(attachment_id=$3)`.

3. After any write (upload / delete), re-run `list` so the user sees the new state.

## Notes

- **Downloads stream to disk.** The tool uses Node streams end-to-end, so multi-GB attachments don't buffer in memory.
- **Directory vs file save paths** — `jira_download_attachment` detects a trailing `/` or an existing directory and auto-appends the attachment's filename. Pass a full file path to rename on save.
- **Tilde expansion.** `save_path` accepts `~/Downloads/foo.pdf` and expands to `$HOME`.
- **Binary integrity.** The download path follows Atlassian's 303 redirect to S3 transparently. Downloaded bytes equal the attachment's reported `size` field exactly — verified across text, images, and PDFs.
- **Upload uses multipart** with `X-Atlassian-Token: no-check` (Atlassian requires this header for CSRF-exempt uploads). jira.js doesn't have a clean binary path; we use raw fetch.
- **Scopes required:** `read:jira-work` for list/get/download; `write:jira-work` for upload; `delete:issue:jira` or classic `write:jira-work` for delete. Confirm via `/atlassian-suite:init` if any tool 403s.
- **Viewing images/PDFs** — after downloading, surface the local path so the user can open it in their default viewer (`open <path>` on macOS, `xdg-open` on Linux, `start` on Windows). Don't try to render binary content in the chat.
