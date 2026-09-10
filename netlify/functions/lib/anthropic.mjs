import Anthropic from '@anthropic-ai/sdk';
let client;
export function getClient() { if (!client) client = new Anthropic(); return client; }
export const MODEL = process.env.AGENT_MODEL || 'claude-opus-5';
export const EFFORT = process.env.AGENT_EFFORT || 'high';
// 'claude' when credentials exist, else 'mock'. Override with WALKAWAY_BRAIN=mock|claude.
export const BRAIN = process.env.WALKAWAY_BRAIN || ((process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) ? 'claude' : 'mock');
