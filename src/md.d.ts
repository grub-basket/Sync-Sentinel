// esbuild's text loader turns a `.md` import into its file contents as a string
// (see esbuild.config.mjs). This declaration lets tsc accept those imports.
declare module "*.md" {
  const content: string;
  export default content;
}
