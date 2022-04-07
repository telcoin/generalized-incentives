// this code will test S and V matrices by randomly selecting points and checking against an external data source

import { assert } from "chai";
import { ethers } from "ethers";
import math from "mathjs";

import * as graph from '../api/graph';

export async function testVBalancer(_V: number[], poolAddress: string, startBlock: number, endBlock: number, nTests: number = 100) {
    // nTests: number of random selections to perform


    // sanity checks
    assert(_V.length === endBlock - startBlock);
    assert(_V.filter(x => x < 0).length === 0); // no negatives

    const promises: Promise<void>[] = [];
    for (let n = 0; n < nTests; n++) {
        promises.push(new Promise(async (resolve, reject) => {
            const randomIndex = Math.floor(Math.random()*_V.length);
            const block = startBlock + randomIndex;
            
            const graphValue = await graph.getLpTokenValueAtBlockBalancer(poolAddress, block);
            
            assert(graphValue === _V[randomIndex]);
            resolve();
        }));
    }

    await Promise.all(promises);
}

export async function testS(_S: number[][], addressList: string[], poolAddress: string, startBlock: number, endBlock: number, nTests: number = 100) {
    // dimension checks
    assert(_S.length === addressList.length);
    assert(_S.map(row => row.length === endBlock - startBlock).filter(bool => !bool).length === 0);

    const url = "https://polygon-mainnet.g.alchemy.com/v2/" + process.env.ALCHEMYKEY;

    const provider = new ethers.providers.JsonRpcProvider(url);

    const erc20 = new ethers.Contract(poolAddress, require('./erc20abi.json'), provider);

    // erc20.connect(provider);
    const promises: Promise<void>[] = [];
    for (let n = 0; n < nTests; n++) {
        promises.push(new Promise(async (resolve, reject) => {
            const randCol = Math.floor(Math.random()*_S[0].length);
            const randRow = Math.floor(Math.random()*_S.length);
            
            const address = addressList[randRow];
            const block = startBlock + randCol;
            
            assert(parseInt(await erc20.balanceOf(address, {blockTag: block})) === _S[randRow][randCol]);

            resolve();
        }));
    }
    
    await Promise.all(promises);
}

export function testDiversity(yVecPerPool: {[key: string]: math.Matrix}, dVecPerPool: {[key: string]: math.Matrix}, B:number, nTests: number = 2000) {
    assert(JSON.stringify(Object.keys(yVecPerPool).sort()) === JSON.stringify(Object.keys(dVecPerPool).sort()));
    const len = Object.values(yVecPerPool)[0].toArray().length;

    Object.keys(yVecPerPool).forEach(k => {
        assert(yVecPerPool[k].toArray().length === len);
        assert(dVecPerPool[k].toArray().length === len);
    });
    const pools = Object.keys(yVecPerPool);

    const nPools = pools.length;
    for (let n = 0; n < nTests; n++) {
        const poolI = Math.floor(Math.random()*nPools);
        const addressI = Math.floor(Math.random()*len);

        let ans = 0;
        for (let i = 0; i < nPools; i++) {
            if (i === poolI) continue;
            const other = yVecPerPool[pools[i]].toArray() as number[];
            const thisOne = yVecPerPool[pools[poolI]].toArray() as number[];
            if (other[addressI] !== 0 && thisOne[addressI] !== 0) {
                ans += Math.min(other[addressI]/thisOne[addressI], 1);
            }
        }

        const dvec = dVecPerPool[pools[poolI]].toArray() as number[];
        assert(ans*B+1 === dvec[addressI]);
    }
}