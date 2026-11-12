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
  ANY_RELAYER,
  Payout,
  attestDigest,
  attestTypedData,
  checkLink,
  claimDigest,
  claimTypedData,
  linkKeyAddress,
  linkKeyFromHash,
  packetLink,
  parseLinkFragment,
  permitTypedData,
  signClaimWithLinkKey,
  type PayoutValue,
} from './eip712';

/*
 * Vectors produced by the real v2 contract: contracts/src/Hongbao.sol (with the
 * test mocks as wiring) placed at HB with vm.etch on chain 31611 / 31612, then
 * hb.claimDigest(id, recipient, payout, relayer), hb.attestDigest(id, recipient,
 * payout, deadline), hb.domainSeparator() and vm.sign(0xA11CE, digest).
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
  relayer: Address;
  digest: Hex;
  sig: Hex;
}[] = [
  {
    chainId: 31611,
    id: 1n,
    recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    payout: Payout.Stake,
    relayer: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    digest: '0x5e9c966a41c13132c531687ae601425eb8527ace2ce108df66bdf631b0b5245b',
    sig: '0x4249800a61f27cd3a67ce59746586933812e32ee648d1a3af9ac92018f74262921f2ab2b4b508824046161e667eefcda356879bd862fecfeaff3c6177eede0291c',
  },
  {
    chainId: 31612,
    id: 42n,
    recipient: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    payout: Payout.Save,
    relayer: ANY_RELAYER,
    digest: '0xdc5b57ebfd76bd1f3c9c9eea5954f140019b2b575fdb8a05cd58c8f0998ac9eb',
    sig: '0x29a5895817d7cea6a872e51b361d840535074959eb0bf2eb0e3e14426e0b34f9001c3733d30fc17ecc19501d9a9960f27c500a2a3579e9d1ef3ce36d5af1708d1b',
  },
  {
    chainId: 31611,
    id: 18446744073709551623n, // 2^64 + 7
    recipient: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    payout: Payout.Cash,
    relayer: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
    digest: '0x3c859440ad0831617c9701b959ef72bf50495eab258714508b7b390dff2af3b1',
    sig: '0x51e35d4b02735ca66360e0bbf91ef6d33529abd3d598303fb3ae6687fc2423ae3f1136a2a285dbe203d26a034b4eefa2be52700bf962e662b8182bdd3b9392d41b',
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
      expect(claimDigest(v.chainId, HB, v.id, v.recipient, v.payout, v.relayer)).toBe(v.digest);
      expect(hashTypedData(claimTypedData(v.chainId, HB, v.id, v.recipient, v.payout, v.relayer))).toBe(v.digest);
    });

    it(`hand-built EIP-712 hash agrees for packet ${v.id}`, () => {
      const typeHash = keccak256(stringToHex('Claim(uint256 packetId,address recipient,uint8 payout,address relayer)'));
      const structHash = keccak256(
        encodeAbiParameters(
          [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint8' }, { type: 'address' }],
          [typeHash, v.id, v.recipient, v.payout, v.relayer],
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
      const sig = await signClaimWithLinkKey(LINK_KEY, v.chainId, HB, v.id, v.recipient, v.payout, v.relayer);
      expect(sig).toBe(v.sig);
      const recovered = await recoverTypedDataAddress({
        ...claimTypedData(v.chainId, HB, v.id, v.recipient, v.payout, v.relayer),
        signature: sig,
      });
      expect(recovered).toBe(LINK_KEY_ADDRESS);
    });
  }

  it('a signature for one recipient does not recover the key for another', async () => {
    const v = CLAIM_VECTORS[0];
    const sig = await signClaimWithLinkKey(LINK_KEY, v.chainId, HB, v.id, v.recipient, v.payout, v.relayer);
    const other = await recoverTypedDataAddress({
      ...claimTypedData(v.chainId, HB, v.id, CLAIM_VECTORS[1].recipient, v.payout, v.relayer),
      signature: sig,
    });
    expect(other).not.toBe(LINK_KEY_ADDRESS);
  });

  it('a signature bound to one relayer does not recover the key for another relayer or for anyone', async () => {
    const v = CLAIM_VECTORS[0];
    const sig = await signClaimWithLinkKey(LINK_KEY, v.chainId, HB, v.id, v.recipient, v.payout, v.relayer);
    for (const relayer of [CLAIM_VECTORS[2].relayer, ANY_RELAYER]) {
      const other = await recoverTypedDataAddress({
        ...claimTypedData(v.chainId, HB, v.id, v.recipient, v.payout, relayer),
        signature: sig,
      });
      expect(other).not.toBe(LINK_KEY_ADDRESS);
    }
  });

  it('a freshly generated key signs claims that recover to its own address', async () => {
    const key = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318' as Hex;
    const addr = privateKeyToAccount(key).address;
    expect(linkKeyAddress(key)).toBe(addr);
    const relayer: Address = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
    const td = claimTypedData(31611, HB, 7n, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', Payout.Save, relayer);
    const sig = await signClaimWithLinkKey(key, 31611, HB, 7n, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', Payout.Save, relayer);
    expect(await recoverTypedDataAddress({ ...td, signature: sig })).toBe(addr);
  });
});

describe('Attest typed data', () => {
  const who: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

  it('digest matches Hongbao.attestDigest(id, recipient, payout, deadline)', () => {
    expect(hashTypedData(attestTypedData(31611, HB, 1n, who, Payout.Stake, 1800000600n))).toBe(
      '0x42b745baa9ab8b0028f5365d246efeb890ec5131a20cf622735bceea2f946082',
    );
    expect(attestDigest(31611, HB, 1n, who, Payout.Cash, 1800000600n)).toBe(
      '0xde6bef9d992bb116d89a8745ca8ca0c925d8b558f200a548e528a2336d6ab2eb',
    );
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

  it('new links carry the contract: #k=<key>&c=<hongbao>', () => {
    const link = packetLink('https://example.test', 31611, 12n, LINK_KEY, HB);
    expect(link).toBe(`https://example.test/c/31611/12#k=${LINK_KEY}&c=${HB}`);
    const frag = parseLinkFragment(new URL(link).hash);
    expect(frag).toEqual({ key: LINK_KEY, hasContract: true, contract: HB });
    expect(linkKeyFromHash(new URL(link).hash)).toBe(LINK_KEY);
  });

  it('opens a link only when its contract and key match the packet', () => {
    const other: Address = '0x9999999999999999999999999999999999999999';
    const withC = parseLinkFragment(`#k=${LINK_KEY}&c=${HB.toLowerCase()}`);
    expect(checkLink(withC, HB)).toBe('ok');
    expect(checkLink(withC, HB, LINK_KEY_ADDRESS)).toBe('ok');
    expect(checkLink(withC, HB, other)).toBe('keyMismatch');
    // Another deployment's link is refused before the packet is even read.
    expect(checkLink(parseLinkFragment(`#k=${LINK_KEY}&c=${other}`), HB)).toBe('otherDeployment');
    expect(checkLink(parseLinkFragment(`#k=${LINK_KEY}&c=0x12`), HB)).toBe('otherDeployment');
    expect(checkLink(parseLinkFragment(`#c=${other}`), HB)).toBe('otherDeployment');
  });

  it('keeps accepting old #k=-only links, checked against the packet’s claimKey', () => {
    const old = parseLinkFragment(`#k=${LINK_KEY}`);
    expect(old).toEqual({ key: LINK_KEY, hasContract: false, contract: null });
    expect(checkLink(old, HB, LINK_KEY_ADDRESS)).toBe('ok');
    expect(checkLink(old, HB, HB)).toBe('keyMismatch');
    expect(checkLink(parseLinkFragment(''), HB, LINK_KEY_ADDRESS)).toBe('noKey');
  });
});
