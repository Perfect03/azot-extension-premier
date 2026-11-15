import { vi } from 'vitest';

// This service is supplied by Azot, so it has no runtime npm dependency.
export const EME = vi.fn<new () => InstanceType<typeof import('eme').EME>>();
