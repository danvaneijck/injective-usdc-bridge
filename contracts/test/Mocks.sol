// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDC is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address who, bool v) external {
        blocked[who] = v;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[from] && !blocked[to], "MockUSDC: blacklisted");
        super._update(from, to, value);
    }
}

/// @dev Behaves like MessageTransmitterV2 + TokenMessengerV2 for burn
/// messages: parses the real byte layout, enforces destinationCaller and
/// single use of the nonce, then mints (amount - feeExecuted) to mintRecipient.
contract MockMessageTransmitter {
    MockUSDC public immutable usdc;
    mapping(bytes32 => uint256) public usedNonces;

    constructor(MockUSDC usdc_) {
        usdc = usdc_;
    }

    function receiveMessage(bytes calldata message, bytes calldata) external returns (bool) {
        bytes32 nonce = bytes32(message[12:44]);
        address caller = address(uint160(uint256(bytes32(message[108:140]))));
        require(caller == address(0) || caller == msg.sender, "Invalid caller for message");
        require(usedNonces[nonce] == 0, "Nonce already used");
        usedNonces[nonce] = 1;
        if (message.length >= 148 + 228) {
            address mintRecipient = address(uint160(uint256(bytes32(message[184:216]))));
            uint256 amount = uint256(bytes32(message[216:248]));
            uint256 feeExecuted = uint256(bytes32(message[312:344]));
            if (amount > feeExecuted) usdc.mint(mintRecipient, amount - feeExecuted);
        }
        return true;
    }
}

contract NoReceive {}

/// @dev Tries to re-enter relay() from its receive(); must not succeed.
contract Reenterer {
    address public target;
    bytes public message;
    bool public attempted;
    bool public reentered;

    function arm(address target_, bytes calldata message_) external {
        target = target_;
        message = message_;
    }

    receive() external payable {
        attempted = true;
        (bool ok,) = target.call(abi.encodeWithSignature("relay(bytes,bytes)", message, bytes("")));
        reentered = ok;
    }
}
