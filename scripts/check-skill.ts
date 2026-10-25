// Runs the skill gate from a clssck/agent-plugins checkout against skills/atl (CI runs the same checker at a pinned
// commit). The checkout is $AGENT_PLUGINS_DIR, default ../agent-plugins. Not part of `bun run check`: it needs the sibling checkout.

import { existsSync } from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const configured = process.env["AGENT_PLUGINS_DIR"];
const checkout = path.resolve(
  root,
  configured !== undefined && configured !== "" ? configured : "../agent-plugins",
);
const checker = path.join(checkout, "scripts", "check-skill.ts");

if (!existsSync(checker)) {
  process.stderr.write(
    `check:skill needs a clssck/agent-plugins checkout, but ${checker} does not exist.\n` +
      "Clone it next to this repository, or set AGENT_PLUGINS_DIR to its path.\n",
  );
  process.exit(1);
}

const child = Bun.spawn([process.execPath, checker, path.join(root, "skills", "atl")], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);
