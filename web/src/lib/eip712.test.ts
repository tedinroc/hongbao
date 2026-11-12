import { describe, expect, it } from 'vitest';
import {
  concat,
  encodeAbiParameters,
  hashDomain,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  Payout,
  attestTypedData,
  claimDigest,
  claimTypedData,
  linkKeyAddress,
  linkKeyFromHash,
  packetLink,
  permitTypedData,
  signClaimWithLinkKey,
  type PayoutValue,
} from './eip712';

/*
 * Vectors produced by the real contract: contracts/src/Hongbao.sol deployed with
 * Foundry's deployCodeTo at HB on chain 31611 / 31612, then hb.claimDigest(...),
 * hb.attestDigest(...), hb.domainSeparator() and vm.sign(0xA11CE, digest).
 * The MUSD domain separator is the live value from Mezo testnet
 * (cast call 0x1189…c503 "DOMAIN_SEPARATOR()(bytes32)").
 */
const HB: Address = '0x1234567890AbcdEF1234567890aBcdef12345678';
const LINK_KEY: Hex = '0x00000000000000000000000000000000000000000000000000000000000a11ce';
const LINK_KEY_ADDRESS: Address = '0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7';

const CLAIM_VECTORS: {
  chainId: number;
  id: bigint;
  recipient: Address;
  payout: PayoutValue;
  digest: Hex;
  sig: Hex;
}[] = [
  {
    chainId: 31611,
    id: 1n,
    recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    payout: Payout.Stake,
    digest: '0x50c915753e2968b4ba0d9dc65b2f02a60e940b357f087313aaec285af234a5a5',
    sig: '0x37a39ac01804a1cc808ece365c36b065108c1bbaf6df3b516a517b6eb3cc03b429ef054eee37382c1170580165e7380b63128bc22b69d90fcfd62c4595809df51b',
  },
  {
    chainId: 31612,
    id: 42n,
    recipient: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    payout: Payout.Save,
    digest: '0x5152c59181228ddb130a8513b2da52dec784251b73402bd4b918ea62c40dc184',
    sig: '0xf99639981065c359e2d276bc293fb05356689e60a18981b33001242a3d702c5a710e893c5a1000d1187f2cd4f03be0d5d5b640c9d6cb56448c478e7a94046f901c',
  },
  {
    chainId: 31611,
    id: 18446744073709551623n, // 2^64 + 7
    recipient: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    payout: Payout.Cash,
    digest: '0x6071825f9c14094a1f0da0d839d8a8171db1db1a6b841168fc34af3b8c4ba701',
    sig: '0xd77c2042c68db53dce25348216cdf1378170ecc0657a4b535979a5c6cd3cc3ec2d73744a03f06433b5e9d1297c328c37c3b89e6f8a81689aa84accf10595ce041b',
  },
];

describe('Claim typed data', () => {
  it('domain separator equals Hongbao.domainSeparator()', () => {
    const d = (chainId: number) =>
      hashDomain({
        domain: { name: 'Hongbao', version: '1', chainId, verifyingContract: HB },
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
        },
      });
    expect(d(31611)).toBe('0xedc8b3ac29288a9e7125229d20a2831b73fdd481c3ba7c94d5934c86060dc2eb');
    expect(d(31612)).toBe('0x69fadf44d7b81ea66a12b47aa8ba73ced266cbda788dcfae0a75cbcc0edc94bd');
  });

  for (const v of CLAIM_VECTORS) {
    it(`digest matches the contract for packet ${v.id} on ${v.chainId}`, () => {
      expect(claimDigest(v.chainId, HB, v.id, v.recipient, v.payout)).toBe(v.digest);
      expect(hashTypedData(claimTypedData(v.chainId, HB, v.id, v.recipient, v.payout))).toBe(v.digest);
    });

    it(`hand-built EIP-712 hash agrees for packet ${v.id}`, () => {
      const typeHash = keccak256(stringToHex('Claim(uint256 packetId,address recipient,uint8 payout)'));
      const structHash = keccak256(
        encodeAbiParameters(
          [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint8' }],
          [typeHash, v.id, v.recipient, v.payout],
        ),
      );
      const domainTypeHash = keccak256(
        stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
      );
      const domainSep = keccak256(
        encodeAbiParameters(
          [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
          [domainTypeHash, keccak256(stringToHex('Hongbao')), keccak256(stringToHex('1')), BigInt(v.chainId), HB],
        ),
      );
      expect(keccak256(concat(['0x1901', domainSep, structHash]))).toBe(v.digest);
    });

    it(`link-key signature equals Foundry's vm.sign and recovers for packet ${v.id}`, async () => {
      const sig = await signClaimWithLinkKey(LINK_KEY, v.chainId, HB, v.id, v.recipient, v.payout);
      expect(sig).toBe(v.sig);
      const recovered = await recoverTypedDataAddress({
        ...claimTypedData(v.chainId, HB, v.id, v.recipient, v.payout),
        signature: sig,
      });
      expect(recovered).toBe(LINK_KEY_ADDRESS);
    });
  }

  it('a signature for one recipient does not recover the key for another', async () => {
    const v = CLAIM_VECTORS[0];
    const sig = await signClaimWithLinkKey(LINK_KEY, v.chainId, HB, v.id, v.recipient, v.payout);
    const other = await recoverTypedDataAddress({
      ...claimTypedData(v.chainId, HB, v.id, CLAIM_VECTORS[1].recipient, v.payout),
      signature: sig,
    });
    expect(other).not.toBe(LINK_KEY_ADDRESS);
  });

  it('a freshly generated key signs claims that recover to its own address', async () => {
    const key = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318' as Hex;
    const addr = privateKeyToAccount(key).address;
    expect(linkKeyAddress(key)).toBe(addr);
    const td = claimTypedData(31611, HB, 7n, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', Payout.Save);
    const sig = await signClaimWithLinkKey(key, 31611, HB, 7n, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', Payout.Save);
    expect(await recoverTypedDataAddress({ ...td, signature: sig })).toBe(addr);
  });
});

describe('Attest typed data', () => {
  it('digest matches Hongbao.attestDigest()', () => {
    const td = attestTypedData(31611, HB, 1n, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 1800000600n);
    expect(hashTypedData(td)).toBe('0x4fa83cfe11dc0dbd8c8d84826ef24356995019e67d2e2d404f7453169234efec');
  });
});

describe('MUSD permit typed data', () => {
  const MUSD_TESTNET: Address = '0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503';

  it('domain equals the live Mezo testnet MUSD DOMAIN_SEPARATOR', () => {
    const td = permitTypedData({
      chainId: 31611,
      token: MUSD_TESTNET,
      owner: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      spender: HB,
      value: 1n,
      nonce: 0n,
      deadline: 1n,
    });
    expect(
      hashDomain({
        domain: td.domain,
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
        },
      }),
    ).toBe('0x6f9f5c5d441374bdc3939f5da85a145469d7ffbc96bfe0cce59e5de7d8f1474f');
  });

  it('permit digest matches OpenZeppelin ERC20Permit', () => {
    const td = permitTypedData({
      chainId: 31611,
      token: MUSD_TESTNET,
      owner: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      spender: HB,
      value: 25n * 10n ** 18n,
      nonce: 3n,
      deadline: 1800001800n,
    });
    expect(hashTypedData(td)).toBe('0x9ca51c7b5651800987cc96b59a7bcda8bc93d6d71a54da705ad760492a092d58');
  });
});

describe('link format', () => {
  it('builds /c/<chainId>/<id>#k=<key> and reads the key back', () => {
    const link = packetLink('https://example.test/', 31611, 12n, LINK_KEY);
    expect(link).toBe(`https://example.test/c/31611/12#k=${LINK_KEY}`);
    expect(linkKeyFromHash(new URL(link).hash)).toBe(LINK_KEY);
  });

  it('accepts a key without 0x and in upper case', () => {
    expect(linkKeyFromHash(`#k=${LINK_KEY.slice(2).toUpperCase()}`)).toBe(LINK_KEY);
  });

  it('rejects missing, short, zero and out-of-range keys', () => {
    expect(linkKeyFromHash('')).toBeNull();
    expect(linkKeyFromHash('#k=0x1234')).toBeNull();
    expect(linkKeyFromHash(`#k=0x${'0'.repeat(64)}`)).toBeNull();
    expect(linkKeyFromHash(`#k=0x${'f'.repeat(64)}`)).toBeNull();
    expect(linkKeyFromHash('#x=1')).toBeNull();
  });
});
