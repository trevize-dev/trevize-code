/**
 * Trevize: our own server releases, so installs never fetch upstream T3 Code
 * (pingdotgg/t3code, `v` tags). Data lives in `~/.trevize` (see the npm launcher).
 */

/** GitHub repository whose releases carry the CLI archives and `SHA256SUMS`. */
export const TREVIZE_CLI_RELEASE_REPOSITORY = "trevize-dev/trevize-code";
/** Trevize release tags are `trevize-vX.Y.Z`; the repo also carries upstream's `v` tags. */
export const TREVIZE_CLI_RELEASE_TAG_PREFIX = "trevize-v";
/** The npm launcher package (`npx @trevize-dev/code`, or `trevize code` from the Trevize CLI). */
export const TREVIZE_CLI_NPM_PACKAGE = "@trevize-dev/code";
/** The command the npm launcher package exposes. */
export const TREVIZE_CLI_COMMAND = "trevize-code";
