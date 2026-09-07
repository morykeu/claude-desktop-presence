import type { ClaudeProcessInfo, ProcessSampler } from '../../src/sources/process.js';

export const OFFLINE: ClaudeProcessInfo = {
  running: false,
  mainPid: null,
  allPids: [],
  startTime: null,
  cpuPercent: 0,
};

/** A sampler that replays a fixed list of CPU readings, then reports "not running". */
export function scriptedSampler(values: readonly number[], cores = 12): ProcessSampler {
  let index = 0;
  let last: ClaudeProcessInfo = OFFLINE;
  return {
    get last() {
      return last;
    },
    cores: () => Promise.resolve(cores),
    sample: () => {
      const value = values[index++];
      last =
        value === undefined
          ? OFFLINE
          : { running: true, mainPid: 1, allPids: [1], startTime: new Date(0), cpuPercent: value };
      return Promise.resolve(last);
    },
  };
}
