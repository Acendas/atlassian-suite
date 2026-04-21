// Confluence tool registration entry point.
//
// v2-first + v1-targeted-fallback. Each registerXTools() receives a
// readOnly flag so tools that mutate state can refuse when the server
// starts in READ_ONLY_MODE.

import type { FastMCP } from "fastmcp";
import { confluenceIsConfigured } from "../common/confluenceClient.js";
import { registerPageTools } from "./pages.js";
import { registerEditTools } from "./edits.js";
import { registerCommentTools } from "./comments.js";
import { registerInlineCommentTools } from "./inlineComments.js";
import { registerSpaceTools } from "./spaces.js";
import { registerLabelTools } from "./labels.js";
import { registerAttachmentTools } from "./attachments.js";
import { registerUserTools } from "./users.js";
import { registerLikeTools } from "./likes.js";
import { registerWatcherTools } from "./watchers.js";
import { registerCopyTools } from "./copy.js";
import { registerPropertyTools } from "./properties.js";
import { registerVersionTools } from "./versions.js";

export interface RegisterOptions {
  readOnly: boolean;
}

export function registerConfluenceTools(server: FastMCP, opts: RegisterOptions): void {
  if (!confluenceIsConfigured()) {
    console.error("[acendas-atlassian] Confluence: not configured, skipping tool registration.");
    return;
  }
  registerPageTools(server, opts);
  registerEditTools(server, opts);
  registerCommentTools(server, opts);
  registerInlineCommentTools(server, opts);
  registerSpaceTools(server);
  registerLabelTools(server, opts);
  registerAttachmentTools(server, opts);
  registerUserTools(server);
  registerLikeTools(server, opts);
  registerWatcherTools(server, opts);
  registerCopyTools(server, opts);
  registerPropertyTools(server, opts);
  registerVersionTools(server, opts);
}
