/**
 * Where this project is published. Fill in your own account names, then run
 * "node release.mjs" — build.mjs reads this to write @updateURL / @downloadURL
 * into the userscript header, so the two stay in sync automatically.
 *
 * Update channel: Tampermonkey checks ONE @updateURL. Gitee raw is used for that
 * because it is uncached, so a new version is seen immediately; the download
 * itself comes from jsDelivr, which serves GitHub reliably from mainland China.
 */
export const REPO = {
  author: 'Ziheng',
  github: { user: 'kaziosuii-crypto', repo: 'moodle-workspace' },
  gitee:  { user: 'Latmil', repo: 'moodle-workspace' }
};
