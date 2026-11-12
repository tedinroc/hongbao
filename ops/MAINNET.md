# Mainnet deployment (you run this; your key never touches the repo)

Prerequisites: testnet run is clean, the review findings are fixed, and your mainnet wallet on Mezo holds a little BTC for gas (deployment ≈ 3.5M gas; at ~1.5e6 wei/gas that is ≈ 0.000005 BTC).

## 1. Import your key into an encrypted Foundry keystore (once)

```bash
~/.foundry/bin/cast wallet import hongbao-mainnet --interactive
```

It asks for the private key and a password in the terminal and stores an encrypted keystore in `~/.foundry/keystores/`. Nothing is echoed or written to this repo.

## 2. Dry run (no transaction)

```bash
cd contracts
TREASURY=<your address> GUARDIAN=<your address> ~/.foundry/bin/forge script script/Deploy.s.sol \
  --fork-url https://mainnet.mezo.public.validationcloud.io --account hongbao-mainnet
```

## 3. Deploy

```bash
TREASURY=<your address> GUARDIAN=<your address> ~/.foundry/bin/forge script script/Deploy.s.sol \
  --rpc-url https://mainnet.mezo.public.validationcloud.io --account hongbao-mainnet --broadcast --slow
```

Copy the printed `Hongbao deployed at 0x…` address and send it to me; I will verify the source on the Mezo explorer, update `config/deployments.json`, enable mainnet in the app and relayer, and redeploy the site.

Beta caps at launch: 50 MUSD per packet, 100 MUSD open per sender, 500 MUSD open in total, 1% fee. The guardian can change the caps only within hard caps fixed at deployment: 100 / 500 / 5,000 MUSD.

## 4. Fund your first packets

From the app's Send page with the same wallet (browser wallet such as Rabby or MetaMask connected to Mezo mainnet, chain 31612): fund with MUSD (one permit signature + one transaction), or with BTC.
