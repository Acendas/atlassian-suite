declare module "adf-to-md" {
  /**
   * Translate an Atlassian Document Format JSON document into Markdown.
   * adf-to-md@1.x is CommonJS; consume via the default import.
   */
  type TranslateFn = (adf: unknown) => string | { result: string; warnings?: unknown[] };
  const _default: { translate: TranslateFn };
  export default _default;
}
