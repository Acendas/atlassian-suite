// Confluence page diff: compute textual difference between two versions of a page.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { confluenceClient } from "../common/confluenceClient.js";
import { adfToMarkdown } from "../common/adf.js";
import { safeConfluence } from "./_helpers.js";

export function registerDiffTools(server: FastMCP): void {
  server.addTool({
    name: "confluence_get_page_diff",
    description:
      "Compute a unified-style textual diff between two versions of a Confluence page (uses Markdown projection of ADF).",
    parameters: z.object({
      page_id: z.string(),
      from_version: z.number().int().positive(),
      to_version: z.number().int().positive(),
    }),
    execute: async (args: { page_id: string; from_version: number; to_version: number }) =>
      safeConfluence(async () => {
        const [fromPage, toPage] = await Promise.all([
          confluenceClient().content.getContentById({
            id: args.page_id,
            version: args.from_version,
            expand: ["body.atlas_doc_format", "version"],
          } as never),
          confluenceClient().content.getContentById({
            id: args.page_id,
            version: args.to_version,
            expand: ["body.atlas_doc_format", "version"],
          } as never),
        ]);

        const decode = (page: any): string => {
          const raw = page?.body?.atlas_doc_format?.value;
          if (!raw) return "";
          try {
            return adfToMarkdown(JSON.parse(raw));
          } catch {
            return String(raw);
          }
        };

        const fromMd = decode(fromPage);
        const toMd = decode(toPage);
        return {
          page_id: args.page_id,
          from: { version: args.from_version, title: (fromPage as any)?.title },
          to: { version: args.to_version, title: (toPage as any)?.title },
          diff: lineDiff(fromMd, toMd),
        };
      }),
  });
}

interface DiffLine {
  op: " " | "+" | "-";
  text: string;
}

// Compact line-based diff using LCS. Suitable for human review of Confluence prose.
function lineDiff(a: string, b: string): DiffLine[] {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const n = aLines.length;
  const m = bLines.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (aLines[i] === bLines[j]) lcs[i][j] = lcs[i + 1][j + 1] + 1;
      else lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      out.push({ op: " ", text: aLines[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ op: "-", text: aLines[i] });
      i++;
    } else {
      out.push({ op: "+", text: bLines[j] });
      j++;
    }
  }
  while (i < n) {
    out.push({ op: "-", text: aLines[i] });
    i++;
  }
  while (j < m) {
    out.push({ op: "+", text: bLines[j] });
    j++;
  }
  return out;
}
