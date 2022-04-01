// this code will test S and V matrices by randomly selecting points and checking against an external data source

import { assert } from "console";
import { ethers } from "ethers";

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

    console.log("_V checks done!");
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

    console.log('_S checks done!');
}