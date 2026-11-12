// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";

Vm constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

contract MockMUSD is ERC20Permit {
    constructor() ERC20("Mezo USD", "MUSD") ERC20Permit("Mezo USD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Mirrors MUSDSavingsRate semantics: 1:1 mint, per-holder yield index,
///      withdraw() pays pending yield to the caller before returning principal.
contract MockSavings is ERC20 {
    IERC20 public immutable musd;
    uint256 public yieldIndex;
    mapping(address => uint256) public supplyYieldIndex;
    mapping(address => uint256) public claimableYield;
    bool public withdrawBroken;

    constructor(IERC20 _musd) ERC20("MUSD Savings Rate", "sMUSD") {
        musd = _musd;
    }

    function setWithdrawBroken(bool b) external {
        withdrawBroken = b;
    }

    function deposit(uint256 amount) external {
        require(amount > 0, "zero");
        musd.transferFrom(msg.sender, address(this), amount);
        _mint(msg.sender, amount);
    }

    function withdraw(uint256 amount) external {
        require(!withdrawBroken, "paused");
        require(amount > 0, "zero");
        require(balanceOf(msg.sender) >= amount, "balance");
        _claimYield(msg.sender);
        _burn(msg.sender, amount);
        musd.transfer(msg.sender, amount);
    }

    function claimYield() external returns (uint256) {
        return _claimYield(msg.sender);
    }

    /// @dev Test helper: distribute `amount` MUSD of yield pro rata (caller must hold it).
    function addYield(uint256 amount) external {
        musd.transferFrom(msg.sender, address(this), amount);
        yieldIndex += amount * 1e18 / totalSupply();
    }

    function _claimYield(address who) internal returns (uint256 c) {
        _updateYieldFor(who);
        c = claimableYield[who];
        if (c > 0) {
            claimableYield[who] = 0;
            musd.transfer(who, c);
        }
    }

    function _updateYieldFor(address who) internal {
        uint256 bal = balanceOf(who);
        if (bal > 0) {
            uint256 d = yieldIndex - supplyYieldIndex[who];
            if (d > 0) claimableYield[who] += bal * d / 1e18;
        }
        supplyYieldIndex[who] = yieldIndex;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != to) {
            if (from != address(0)) _updateYieldFor(from);
            if (to != address(0)) _updateYieldFor(to);
        }
        super._update(from, to, value);
    }
}

contract MockVoter {
    mapping(address => bool) public isAlive;

    function setAlive(address g, bool a) external {
        isAlive[g] = a;
    }
}

contract MockGauge {
    address public immutable stakingToken;
    address public immutable voter;
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    bool public broken;

    constructor(address _staking, address _voter) {
        stakingToken = _staking;
        voter = _voter;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function deposit(uint256 amount, address recipient) external {
        require(!broken, "gauge broken");
        require(MockVoter(voter).isAlive(address(this)), "NotAlive");
        IERC20(stakingToken).transferFrom(msg.sender, address(this), amount);
        balanceOf[recipient] += amount;
        totalSupply += amount;
    }
}

contract MockPriceFeed {
    uint256 public price = 74_000e18;
    bool public stale;

    function set(uint256 p, bool s) external {
        price = p;
        stale = s;
    }

    function fetchPrice() external view returns (uint256) {
        require(!stale, "PriceFeed: Oracle is stale.");
        return price;
    }
}

/// @dev Emulates Mezo's BTC ERC-20 precompile: balances ARE native balances.
contract MockBTC {
    mapping(address => mapping(address => uint256)) public allowance;

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function balanceOf(address a) external view returns (uint256) {
        return a.balance;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "BTC allowance");
        require(from.balance >= amount, "BTC balance");
        allowance[from][msg.sender] -= amount;
        VM.deal(from, from.balance - amount);
        VM.deal(to, to.balance + amount);
        return true;
    }
}

/// @dev Swaps BTC (via MockBTC) into MUSD at `price * rateBps / 1e4`.
contract MockRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    MockBTC public immutable btc;
    MockMUSD public immutable musd;
    uint256 public price = 74_000e18;
    uint256 public rateBps = 9950;

    constructor(MockBTC _btc, MockMUSD _musd) {
        btc = _btc;
        musd = _musd;
    }

    function setRate(uint256 p, uint256 bps) external {
        price = p;
        rateBps = bps;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(block.timestamp <= deadline, "Expired");
        require(routes.length == 1 && routes[0].from == address(btc) && routes[0].to == address(musd), "route");
        uint256 out = amountIn * price / 1e18 * rateBps / 10_000;
        require(out >= amountOutMin, "InsufficientOutputAmount");
        // Checked before moving BTC: vm.deal inside a reverting call is not rolled back.
        btc.transferFrom(msg.sender, address(this), amountIn);
        musd.mint(to, out);
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = out;
    }
}

contract RevertingReceiver {
    receive() external payable {
        revert("no BTC");
    }
}
