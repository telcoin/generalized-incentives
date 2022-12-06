import { BigNumber } from "ethers";
import { createAlchemyWeb3 } from "@alch/alchemy-web3";
import {HistoricalTokenValue} from "./types";
import * as fs from "fs";
import path from "path";
import { consoleReplaceLine, decimalToPercent, shortenAddress } from "../helpers/misc";
import {Contract} from 'web3-eth-contract';

const web3 = createAlchemyWeb3("https://polygon-mainnet.g.alchemy.com/v2/" + process.env.ALCHEMYKEY);

const balancerVaultAbi = require(__dirname + '/abi/balancerVault.json');
const balancerLptAbi = require(__dirname + '/abi/balancerLpt.json');
// const provider = new ethers.providers.AlchemyProvider(137, process.env.ALCHEMYKEY);
// const vaultContract = new ethers.Contract("0xba12222222228d8ba445958a75a0704d566bf2c8", balancerVaultAbi, provider);
const vaultContract = new web3.eth.Contract(balancerVaultAbi, "0xba12222222228d8ba445958a75a0704d566bf2c8");

export default vaultContract;

const lptContracts: {[key:string]: Contract} = {};

const BATCH_SIZE = 5;
const RETRIES = 5;

export async function getLptValuesAtManyBlocks(address: string, blockNums: number[]): Promise<HistoricalTokenValue[]> {
    let promises: Promise<number>[] = [];
    let results: number[] = [];
    let ans: HistoricalTokenValue[] = [];

    for (let i = 0; i < blockNums.length; i++) {
        promises.push(getLptValueAtBlock(address, blockNums[i]));

        if (promises.length === BATCH_SIZE) {
            results = results.concat(await Promise.all(promises));
            consoleReplaceLine(`fetch liquidity data for ${shortenAddress(address)}: ${decimalToPercent(results.length / blockNums.length)}%`);
            promises = [];
        }
    }

    results = results.concat(await Promise.all(promises));

    for (let i = 0; i < blockNums.length; i++) {
        ans.push({
            block: blockNums[i],
            value: results[i]
        });
    }

    consoleReplaceLine(`fetch liquidity data for ${shortenAddress(address)}: 100%\n`);

    return ans;
}

export async function getLptValueAtBlock(address: string, blockNum: number) {
    const telInPool = await getTelInPoolAtBlock(address, blockNum);
    const totalSupply = await getLptSupplyAtBlock(address, blockNum);

    return Number(telInPool) / Number(totalSupply);
}

export async function getTelInPoolAtBlock(address: string, blockNum: number) {
    const poolId = await getPoolIdFromLptAddress(address);
    const result = await callContractWithRetries(
        vaultContract,
        "getPoolTokenInfo",
        [poolId, "0xdF7837DE1F2Fa4631D716CF2502f8b230F1dcc32"],
        blockNum
    );
    return BigNumber.from(result.cash);
}

export async function getLptSupplyAtBlock(address: string, blockNum: number): Promise<BigNumber> {
    return BigNumber.from(await callContractWithRetries(
        getLptContract(address),
        "totalSupply",
        [],
        blockNum
    ));
    // return (await getLptContract(address).functions.totalSupply({blockTag: blockNum}))[0];
}

export async function getPoolIdFromLptAddress(addr: string): Promise<string> {
    return (await callContractWithRetries(
        getLptContract(addr),
        "getPoolId",
        [],
        "latest"
    ));
    // return (await getLptContract(addr).functions.getPoolId())[0];
}

async function callContractWithRetries(contract: Contract, contractFunction: string, params: any[], block: number | string): Promise<any> {
    // return contractFunction(...params).then(result => result).catch(err => {
    //     console.log('\n\n' + err.message + '\n\n');
    //     if (retries === 0) {
    //         throw err;
    //     }
    //     return callContractWithRetries(contractFunction, params, retries - 1);
    // });
    let err: Error = new Error();
    for (let i = 0; i < RETRIES; i++) {
        try {
            return await contract.methods[contractFunction](...params).call({}, block);
        }
        catch (e) {
            err = e as Error;
            console.log(err.message);
        }
    }
    throw err;
}

export function getLptContract(address: string): Contract {
    if (lptContracts[address] === undefined) {
        lptContracts[address] = new web3.eth.Contract(balancerLptAbi, address);
    }
    return lptContracts[address];
}
