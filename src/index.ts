import { AgentLoop, type AgentOptions } from './core/agent-loop.js';
import { ExtensionHost } from './extensions/host.js';
export { AgentLoop } from './core/agent-loop.js';
export type { AgentOptions, AgentResult, AgentClient, BranchOptions, SideQuestionOptions, SideQuestionEvent } from './core/agent-loop.js';
export { NimClient } from './core/nim-client.js';
export { loadSettings } from './config/settings.js';
export type { Settings, SettingsOverrides, SettingsOptions } from './config/settings.js';
export { readLastModel, rememberModel } from './config/model-preferences.js';
export type { ModelPreferenceOptions } from './config/model-preferences.js';
export { PermissionGate, PermissionError } from './core/permissions.js';
export type { PermissionRules, PermissionMode, PermissionKind, ApprovalRequest, ApprovalHandler } from './core/permissions.js';
export type {PermissionRule,PermissionMetadata} from './core/permissions.js';
export {ProjectMemory} from './core/project-memory.js';
export type {MemoryNote,MemoryChange,ProjectMemoryOptions,PreparedMemoryUpdate} from './core/project-memory.js';
export {resolveWorkspaceInstructions} from './core/workspace-instructions.js';
export {RewindStore} from './core/rewind-store.js';
export type {RewindSummary,RewindPoint} from './core/rewind-store.js';
export {BackgroundTasks} from './core/background-tasks.js';
export type {TaskInfo,TaskLog,TaskStatus} from './core/background-tasks.js';
export {createSandboxInvocation} from './core/sandbox.js';
export type {ShellInvocation,ShellInvocationBuilder} from './core/shell-runner.js';
export { resolveReferences } from './core/references.js';
export type { Reference, ReferenceContext } from './core/references.js';
export { checkModels, saveModelChecks, defaultModelCheckPath } from './core/model-checks.js';
export type { ModelProbe, ModelCheck, ModelCheckReport } from './core/model-checks.js';
export { effortLevels } from './config/effort.js';
export type { Effort } from './config/effort.js';
export { loadModelCatalog, defaultModelCachePath } from './core/model-catalog.js';
export type { ModelCatalog } from './core/model-catalog.js';
export { Interaction } from './core/interaction.js';
export type { QueuedPrompt } from './core/interaction.js';
export { SessionStore, defaultSessionDirectory } from './core/session-store.js';
export type { SessionState, SessionInfo, AgentMode } from './core/session-store.js';
export { ExtensionHost } from './extensions/host.js';
export type { PluginApi, ExtensionTool } from './extensions/host.js';
export { serveRpc, subscribeEvents } from './integrations/rpc.js';
/** Library callers own environment loading and must close the returned agent. */
export async function createAgent(options:AgentOptions & {trustWorkspace?:boolean}):Promise<AgentLoop>{
 const extensions=options.extensions??await ExtensionHost.load(options.workspace,options.trustWorkspace);
 try{return new AgentLoop({...options,extensions});}catch(error){await extensions.close();throw error;}
}
