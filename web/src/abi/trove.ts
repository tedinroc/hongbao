// Generated from shared/mezo-trove-abis.json (do not edit by hand). src/abi/abi.test.ts checks it has not drifted.
// Only the functions the Send page uses for "Fund from my Mezo loan" (SPEC.md, Phase 2).
export const troveManagerAbi = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_borrower",
        "type": "address"
      }
    ],
    "name": "getTroveStatus",
    "outputs": [
      {
        "internalType": "enum ITroveManager.Status",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_borrower",
        "type": "address"
      }
    ],
    "name": "getEntireDebtAndColl",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "coll",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "principal",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "interest",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "pendingCollateral",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "pendingPrincipal",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "pendingInterest",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_borrower",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "_price",
        "type": "uint256"
      }
    ],
    "name": "getCurrentICR",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_borrower",
        "type": "address"
      }
    ],
    "name": "getTroveMaxBorrowingCapacity",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "_price",
        "type": "uint256"
      }
    ],
    "name": "checkRecoveryMode",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MCR",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "CCR",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "getEntireSystemColl",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "entireSystemColl",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "getEntireSystemDebt",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "entireSystemDebt",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_borrower",
        "type": "address"
      }
    ],
    "name": "getTroveInterestRate",
    "outputs": [
      {
        "internalType": "uint16",
        "name": "",
        "type": "uint16"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
] as const;

export const borrowerOperationsAbi = [
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "_debt",
        "type": "uint256"
      }
    ],
    "name": "getBorrowingFee",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "_amount",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "_upperHint",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "_lowerHint",
        "type": "address"
      }
    ],
    "name": "withdrawMUSD",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "_debtAmount",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "_upperHint",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "_lowerHint",
        "type": "address"
      }
    ],
    "name": "openTrove",
    "outputs": [],
    "stateMutability": "payable",
    "type": "function"
  }
] as const;

export const hintHelpersAbi = [
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "_coll",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "_debt",
        "type": "uint256"
      }
    ],
    "name": "computeNominalCR",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "_CR",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "_numTrials",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "_inputRandomSeed",
        "type": "uint256"
      }
    ],
    "name": "getApproxHint",
    "outputs": [
      {
        "internalType": "address",
        "name": "hintAddress",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "diff",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "latestRandomSeed",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
] as const;

export const sortedTrovesAbi = [
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "_NICR",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "_prevId",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "_nextId",
        "type": "address"
      }
    ],
    "name": "findInsertPosition",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
] as const;
