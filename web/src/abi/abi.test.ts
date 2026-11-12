import { describe, expect, it } from 'vitest';
import hongbaoJson from '../../../shared/Hongbao.abi.json';
import mezoJson from '../../../shared/mezo-abis.json';
import { hongbaoAbi } from './hongbao';
import { gaugeAbi, routerAbi, smusdAbi } from './mezo';

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
});
