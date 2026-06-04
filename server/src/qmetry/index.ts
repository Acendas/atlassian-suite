import type { FastMCP } from "fastmcp";
import { registerQMetryProjectTools } from "./projects.js";
import { registerQMetryTestCaseTools } from "./testcases.js";
import { registerQMetryTestCycleTools } from "./testcycles.js";
import { registerQMetryTestPlanTools } from "./testplans.js";
import { registerQMetryExecutionTools } from "./executions.js";

export interface RegisterOptions {
  readOnly: boolean;
}

export function registerQMetryTools(server: FastMCP, opts: RegisterOptions): void {
  registerQMetryProjectTools(server);
  registerQMetryTestCaseTools(server, opts);
  registerQMetryTestCycleTools(server);
  registerQMetryTestPlanTools(server);
  registerQMetryExecutionTools(server, opts);
}
