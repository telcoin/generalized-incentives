import { BigNumber, ethers } from "ethers";
import {HistoricalTokenValue} from "./types";
import * as fs from "fs";
import path from "path";

const balancerVaultAbi = fs.readFileSync(__dirname + '/abi/balancerVault.json').toString();
const balancerLptAbi = fs.readFileSync(__dirname + '/abi/balancerLpt.json').toString();
const provider = new ethers.providers.AlchemyProvider(137, process.env.ALCHEMYKEY);
const vaultContract = new ethers.Contract("0xba12222222228d8ba445958a75a0704d566bf2c8", balancerVaultAbi, provider);

const lptContracts: {[key:string]: ethers.Contract} = {};

const BATCH_SIZE = 30;
const RETRIES = 5;

export async function getLptValuesAtManyBlocks(address: string, blockNums: number[]): Promise<HistoricalTokenValue[]> {
    let promises: Promise<number>[] = [];
    let results: number[] = [];
    let ans: HistoricalTokenValue[] = [];

    for (let i = 0; i < blockNums.length; i++) {
        promises.push(getLptValueAtBlock(address, blockNums[i]));

        if (promises.length === BATCH_SIZE) {
            results = results.concat(await Promise.all(promises));
            console.log(results.length / blockNums.length);
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

    return ans;
}

export async function getLptValueAtBlock(address: string, blockNum: number) {
    const telInPool = await getTelInPoolAtBlock(address, blockNum);
    const totalSupply = await getLptSupplyAtBlock(address, blockNum);
    /// HACK TODO UNDO
    let f = 1;
    if (address === "0xdB1db6E248d7Bb4175f6E5A382d0A03fe3DCc813".toLowerCase()) {
        f = 1/0.6;
        // console.log('a')
    }
    else if (address === "0x186084fF790C65088BA694Df11758faE4943EE9E".toLowerCase()) {
        f = 1/0.5;
        // console.log('b')
    }

    // console.log(address)

    return f*(Number(telInPool) / Number(totalSupply));
}

export async function getTelInPoolAtBlock(address: string, blockNum: number) {
    const poolId = await getPoolIdFromLptAddress(address);
    const result = await callContractWithRetries(
        vaultContract.functions.getPoolTokenInfo, 
        [poolId, "0xdF7837DE1F2Fa4631D716CF2502f8b230F1dcc32", {blockTag: blockNum}]
    );
    // const cash = (await vaultContract.functions.getPoolTokenInfo(poolId, "0xdF7837DE1F2Fa4631D716CF2502f8b230F1dcc32", {blockTag: blockNum})).cash;
    return result.cash as BigNumber;
}

export async function getLptSupplyAtBlock(address: string, blockNum: number): Promise<BigNumber> {
    return (await callContractWithRetries(
        getLptContract(address).functions.totalSupply, 
        [{blockTag: blockNum}]
    ))[0];
    // return (await getLptContract(address).functions.totalSupply({blockTag: blockNum}))[0];
}

async function getPoolIdFromLptAddress(addr: string): Promise<string> {
    return (await getLptContract(addr).functions.getPoolId())[0];
}

async function callContractWithRetries(contractFunction: ethers.ContractFunction<any>, params: any[]) {
    let err: Error = new Error();
    for (let i = 0; i < RETRIES; i++) {
        try {
            return await contractFunction(...params);
        }
        catch (e) {
            err = e as Error;
            console.log(err.message);
        }
    }
    throw err;
}

export function getLptContract(address: string): ethers.Contract {
    if (lptContracts[address] === undefined) {
        lptContracts[address] = new ethers.Contract(address, balancerLptAbi, provider);
    }
    return lptContracts[address];
}
