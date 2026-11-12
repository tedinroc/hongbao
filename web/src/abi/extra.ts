import { erc20Abi, parseAbi } from 'viem';
import { hongbaoAbi } from './hongbao';
import { gaugeAbi, routerAbi, smusdAbi } from './mezo';

/** MUSD: ERC-20 + EIP-2612 permit + EIP-5267 domain + OpenZeppelin v5 errors. */
export const musdAbi = [
  ...erc20Abi,
  ...parseAbi([
    'function nonces(address owner) view returns (uint256)',
    'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
    'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
    'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
    'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  ]),
] as const;

/** MUSD system PriceFeed: USD per BTC, 1e18-scaled; reverts when stale. */
export const priceFeedAbi = parseAbi(['function fetchPrice() view returns (uint256)']);

type ErrorsOf<T extends readonly unknown[]> = Extract<T[number], { type: 'error' }>;

function errorsOf<const T extends readonly { type: string }[]>(abi: T): ErrorsOf<T>[] {
  return abi.filter((x): x is ErrorsOf<T> => x.type === 'error');
}

/**
 * Hongbao ABI plus the custom errors of every contract it calls, so a revert
 * bubbling up from MUSD, the vault, the gauge or the router decodes to a name.
 * (Identical error signatures share a selector, so duplicates decode the same.)
 */
export const hongbaoWithErrorsAbi = [
  ...hongbaoAbi,
  ...errorsOf(musdAbi),
  ...errorsOf(smusdAbi),
  ...errorsOf(gaugeAbi),
  ...errorsOf(routerAbi),
];
