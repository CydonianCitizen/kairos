import { AgentLoop, type AgentOptions } from './core/agent-loop.js';
import { ExtensionHost } from './extensions/host.js';
export { AgentLoop } from './core/agent-loop.js';
export type { AgentOptions, AgentResult, AgentClient } from './core/agent-loop.js';
export { NimClient } from './core/nim-client.js';
export { Interaction } from './core/interaction.js';
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
