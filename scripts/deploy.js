const hre = require("hardhat");
require("dotenv").config();

async function main() {
  const addressesProvider = process.env.AAVE_ADDRESSES_PROVIDER;
  if (!addressesProvider) {
    throw new Error("Set AAVE_ADDRESSES_PROVIDER in .env before deploying");
  }

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  const Factory = await hre.ethers.getContractFactory("FlashLoanArbitrage");
  const contract = await Factory.deploy(addressesProvider, deployer.address);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("FlashLoanArbitrage deployed to:", address);
  console.log("Set ARBITRAGE_CONTRACT in your .env to this address.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
