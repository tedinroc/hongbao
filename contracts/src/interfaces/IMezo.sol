// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Mezo MUSD Savings Rate vault (sMUSD). Mints sMUSD 1:1 for MUSD;
///         yield accrues per holder and is paid by claimYield() or on withdraw.
interface IMUSDSavingsRate {
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external;
    function claimYield() external returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @notice Mezo VaultGauge for sMUSD. deposit(amount, recipient) pulls sMUSD
///         from the caller and credits `recipient`, who earns MEZO emissions.
interface IVaultGauge {
    function deposit(uint256 amount, address recipient) external;
    function stakingToken() external view returns (address);
    function voter() external view returns (address);
}

interface IVoter {
    function isAlive(address gauge) external view returns (bool);
}

/// @notice MUSD system PriceFeed: USD per BTC, 1e18-scaled. Reverts when stale (>60s).
/// @dev Declared non-view on purpose: Mezo's own interface is non-view and the PriceFeed is an
///      upgradeable proxy, so a future implementation may write state (Liquity-style lastGoodPrice).
interface IPriceFeed {
    function fetchPrice() external returns (uint256);
}

/// @notice Tigris (Velodrome-style) router on Mezo.
interface IRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}
