// Trevize: the relay's Postgres lives on Neon instead of PlanetScale. Upstream's
// `PlanetscaleDatabase` in db.ts is left untouched so upstream merges stay clean;
// alchemy.run.ts and worker.ts use the resources defined here instead.
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Drizzle from "@alchemy.run/drizzle";
import * as Neon from "@alchemy.run/neon";
import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";

import { relayDatabaseMode } from "./dbConfig.ts";

/**
 * The prod stage owns the Neon project and migrates its default branch. Every
 * other stage branches off the prod project and migrates its own branch.
 */
export const NeonDatabase = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const schema = yield* Drizzle.Schema("RelaySchema", {
    schema: "./src/persistence/schema.ts",
    out: "./migrations/postgres",
    dialect: "postgres",
  });
  const migrations = { dir: schema.out, table: "relay_migrations" };

  if (relayDatabaseMode(stage) === "shared-database") {
    const project = yield* Neon.Project("RelayNeonProject", {
      name: "trevize-relay",
      region: "aws-eu-central-1",
      migrations,
    }).pipe(RemovalPolicy.retain());
    return { project, branch: undefined, origin: project.origin };
  }

  const project = yield* Neon.Project.ref("RelayNeonProject", { stage: "prod" });
  const branch = yield* Neon.Branch("RelayNeonBranch", { project, migrations });
  return { project, branch, origin: branch.origin };
});

export const RelayHyperdrive = Effect.gen(function* () {
  const { origin } = yield* NeonDatabase;
  return yield* Cloudflare.Hyperdrive.Connection("RelayHyperdrive", {
    origin,
    caching: {
      disabled: true,
    },
    originConnectionLimit: 40,
  });
});
