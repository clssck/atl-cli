import { registry, registerCommands } from "../core/cli.ts";
import { authCommands, authGroups } from "./auth.ts";
import { compassCommands, compassGroups } from "./compass.ts";
import { confluenceWriteCommands } from "./confluence-write.ts";
import { confluenceCommands, confluenceGroups } from "./confluence.ts";
import { graphCommands, graphGroups } from "./graph.ts";
import { jiraWriteCommands } from "./jira-write.ts";
import { jiraCommands, jiraGroups } from "./jira.ts";
import { mcpCommands, mcpGroups } from "./mcp.ts";
import { metaCommands, metaGroups } from "./meta.ts";
import { miscCommands } from "./misc.ts";
import { searchCommands, searchGroups } from "./search.ts";
import { siteCommands } from "./site.ts";
/** Every command module registers here; `src/main.ts` and the parity test import this file. */
registerCommands([
  ...siteCommands,
  ...authCommands,
  ...confluenceCommands,
  ...confluenceWriteCommands,
  ...jiraCommands,
  ...jiraWriteCommands,
  ...searchCommands,
  ...compassCommands,
  ...graphCommands,
  ...mcpCommands,
  ...miscCommands,
  ...metaCommands,
]);
registry.describeGroups({
  ...authGroups,
  ...confluenceGroups,
  ...jiraGroups,
  ...searchGroups,
  ...compassGroups,
  ...graphGroups,
  ...mcpGroups,
  ...metaGroups,
});
