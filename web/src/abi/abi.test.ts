import { describe, expect, it } from 'vitest';
import hongbaoJson from '../../../shared/Hongbao.abi.json';
import mezoJson from '../../../shared/mezo-abis.json';
import troveJson from '../../../shared/mezo-trove-abis.json';
import { hongbaoAbi } from './hongbao';
import { gaugeAbi, routerAbi, smusdAbi } from './mezo';
import { borrowerOperationsAbi, hintHelpersAbi, sortedTrovesAbi, troveManagerAbi } from './trove';

type Item = { type: string; name?: string };

describe('ABI copies have not drifted from shared/', () => {
  it('Hongbao ABI equals shared/Hongbao.abi.json', () => {
    expect(JSON.parse(JSON.stringify(hongbaoAbi))).toEqual(hongbaoJson);
  });

  const mezo = mezoJson as unknown as Record<string, Item[]>;
  const cases: [string, readonly Item[], string][] = [
    ['VaultGauge', gaugeAbi as readonly Item[], 'VaultGauge'],
    ['MUSDSavingsRate', smusdAbi as readonly Item[], 'MUSDSavingsRate'],
    ['Router', routerAbi as readonly Item[], 'Router'],
  ];
  for (const [label, subset, key] of cases) {
    it(`${label} fragments exist verbatim in shared/mezo-abis.json`, () => {
      const source = mezo[key].map((x) => JSON.stringify(x));
      for (const item of subset) expect(source).toContain(JSON.stringify(item));
    });
  }

  const trove = troveJson as unknown as Record<string, Item[]>;
  const troveCases: [string, readonly Item[]][] = [
    ['TroveManager', troveManagerAbi as readonly Item[]],
    ['BorrowerOperations', borrowerOperationsAbi as readonly Item[]],
    ['HintHelpers', hintHelpersAbi as readonly Item[]],
    ['SortedTroves', sortedTrovesAbi as readonly Item[]],
  ];
  for (const [key, subset] of troveCases) {
    it(`${key} fragments exist verbatim in shared/mezo-trove-abis.json`, () => {
      const source = trove[key].map((x) => JSON.stringify(x));
      for (const item of subset) expect(source).toContain(JSON.stringify(item));
    });
  }
});
