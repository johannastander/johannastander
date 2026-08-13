const { expect } = require("chai");
const hre = require("hardhat");

// This is a smoke test, not a full arbitrage simulation. It requires forking
// mainnet (set RPC_URL in .env) so a real Aave PoolAddressesProvider exists
// on-chain to deploy against. Without RPC_URL it's skipped rather than failing.
const AAVE_MAINNET_ADDRESSES_PROVIDER = "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9";

const describeOrSkip = process.env.RPC_URL ? describe : describe.skip;

describeOrSkip("FlashLoanArbitrage", function () {
  it("deploys and sets the owner correctly", async function () {
    const [deployer] = await hre.ethers.getSigners();
    const Factory = await hre.ethers.getContractFactory("FlashLoanArbitrage");
    const contract = await Factory.deploy(AAVE_MAINNET_ADDRESSES_PROVIDER, deployer.address);
    await contract.waitForDeployment();

    expect(await contract.owner()).to.equal(deployer.address);
  });

  it("rejects executeArbitrage from a non-owner account", async function () {
    const [deployer, stranger] = await hre.ethers.getSigners();
    const Factory = await hre.ethers.getContractFactory("FlashLoanArbitrage");
    const contract = await Factory.deploy(AAVE_MAINNET_ADDRESSES_PROVIDER, deployer.address);
    await contract.waitForDeployment();

    const params = {
      routerBuy: hre.ethers.ZeroAddress,
      routerSell: hre.ethers.ZeroAddress,
      intermediate: hre.ethers.ZeroAddress,
      minProfit: 0,
      amountOutMinBuy: 0,
      amountOutMinSell: 0,
      deadline: Math.floor(Date.now() / 1000) + 300,
    };

    await expect(
      contract.connect(stranger).executeArbitrage(hre.ethers.ZeroAddress, 1, params)
    ).to.be.revertedWithCustomError(contract, "OwnableUnauthorizedAccount");
  });

  it("rejects direct calls to executeOperation from non-Pool callers", async function () {
    const [deployer] = await hre.ethers.getSigners();
    const Factory = await hre.ethers.getContractFactory("FlashLoanArbitrage");
    const contract = await Factory.deploy(AAVE_MAINNET_ADDRESSES_PROVIDER, deployer.address);
    await contract.waitForDeployment();

    await expect(
      contract.executeOperation(hre.ethers.ZeroAddress, 1, 0, await contract.getAddress(), "0x")
    ).to.be.revertedWithCustomError(contract, "UnauthorizedCaller");
  });
});
