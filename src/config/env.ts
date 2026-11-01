import { join } from 'node:path';
import { homedir } from 'node:os';
import { config } from 'dotenv';

export function loadEnvironment(workspace: string): void {
  config({
    path: [join(workspace, '.env'), join(homedir(), '.kairos', '.env')],
    override: false,
    quiet: true,
    debug: false,
  });
}
