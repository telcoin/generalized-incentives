import * as dotenv from 'dotenv';
dotenv.config();

import { assert } from 'chai';

import fetch from "cross-fetch";
import fetchRetry from "fetch-retry";
import { ethers } from 'ethers';

import * as math from 'mathjs';

import * as alchemy from './api/alchemy';
import { HistoricalTokenValue, Transfer } from './api/types';

import * as graph from './api/graph';
import { testDiversity, testS, testVBalancer } from './helpers/testingHelper';

import * as fsAsync from 'fs/promises';
import * as fs from 'fs';
import { consoleReplaceLine, decimalToPercent, truncateDecimal } from './helpers/misc';

const POOLS = [
    {
        symbol: "TEL/BAL/USDC",
        address: "0xdB1db6E248d7Bb4175f6E5A382d0A03fe3DCc813".toLowerCase(),
        protocol: "balancer"
    },
    {
        symbol: "TEL/BAL",
        address: "0x186084fF790C65088BA694Df11758faE4943EE9E".toLowerCase(),
        protocol: "balancer"
    },
    // {
    //     symbol: "LINK/BAL/WETH/AAVE",
    //     address: "0xce66904B68f1f070332Cbc631DE7ee98B650b499".toLowerCase(),
    //     protocol: "balancer"
    // },
    // {
    //     symbol: "USDC/LINK/BAL/WETH/AAVE",
    //     address: "0x36128D5436d2d70cab39C9AF9CcE146C38554ff0".toLowerCase(),
    //     protocol: "balancer"
    // },
    // {
    //     symbol: "blah",
    //     address: "0x0297e37f1873D2DAb4487Aa67cD56B58E2F27875".toLowerCase(),
    //     protocol: "balancer"
    // }
    // {
    //     symbol: "TEL/QUICK",
    //     address: "0xe88e24f49338f974b528ace10350ac4576c5c8a1".toLowerCase(),
    //     protocol: "quickswap"
    // }
];

const START_BLOCK = 26548163 + 1*604800/20;
const END_BLOCK = 26548163 + 2*604800/20;

const INCENTIVES = 20000000;
const DECIMALS = 2;

const DIVERSITY_MAX_MULTIPLIER = 1.5;
const DIVERSITY_BOOST_FACTOR = (DIVERSITY_MAX_MULTIPLIER - 1) / (POOLS.length - 1);

const TIME_BASE_MULTIPLIER = 2;
const RESET_TIME = false;

const TIME_MULTIPLIER_RECORDS_DIRECTORY = './timeMultiplierRecords';
const REPORTS_DIRECTORY = './reports';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const blockTimestampToNumber: {[key: string]: string} = {};
const blockNumberToTimestamp: {[key: string]: string} = {};

type TimeDataStack = {
    amount: ethers.BigNumber,
    multiplier: number
}[];

type TimeDataStackMapping = {[key: string]: TimeDataStack};

const TIMING = {
    scriptStart: 0,
    fetchBlocks: {
        start: 0,
        end: 0
    },
    fetchSwaps: {},
    fetchJoinExits: {},
    fetchLiquidity: {},
    fillingData: {
        last: 0,
        total: 0
    },
    casting: {
        start: 0,
        end: 0
    }
};

/////////////////////////////////////////////////////////////

function calculateVFromData(liquidityData: HistoricalTokenValue[], liquidityValueAtStartBlock: number, startBlock: number, endBlock: number): number[] {
    liquidityData.sort((a, b) => {
        return a.block - b.block;
    })

    // make sure it is in ascending block order
    for (let i = 0; i < liquidityData.length-1; i++) {
        assert(liquidityData[i].block <= liquidityData[i+1].block);
    }

    // fill in V - this is the vector of liquidity share value at each block, where the index is (block - START_BLOCK)
    let _V: number[] = [];

    _V = Array(liquidityData[0].block - startBlock).fill(liquidityValueAtStartBlock);

    for (let i = 0; i < liquidityData.length - 1; i++) {
        const liq0 = liquidityData[i];
        const liq1 = liquidityData[i+1];
        _V = _V.concat(Array(liq1.block - liq0.block).fill(liq0.value));
    }

    const liqf = liquidityData[liquidityData.length - 1];
    _V = _V.concat(Array(endBlock - liqf.block).fill(liqf.value));

    assert(_V.length === endBlock - startBlock);

    return _V;
}

async function calculateVBalancer(poolAddress: string, startBlock: number, endBlock: number): Promise<number[]> {
    // to get liquidity data, we first need to get blocks where swaps, adds, or removeds occur
    // get swaps
    const swapTimestamps = await graph.getSwapsTimestampsBalancer(
        poolAddress, 
        blockNumberToTimestamp[startBlock], 
        blockNumberToTimestamp[endBlock]
    );
    
    // get joins/exits
    const joinExitTimestamps = await graph.getJoinExitTimestampsBalancer(
        poolAddress, 
        blockNumberToTimestamp[startBlock], 
        blockNumberToTimestamp[endBlock]
    );

    // get blocks of interactions with pool (swap/join/exit)
    let blocksOfInteraction: number[] = joinExitTimestamps.map(x => parseInt(blockTimestampToNumber[x])).concat(swapTimestamps.map(x => parseInt(blockTimestampToNumber[x])));

    // remove potential duplicates
    blocksOfInteraction = [...new Set(blocksOfInteraction)];

    // get value of 1 LP token at each block where there is a swap, join, or exit
    const liquidityData = await graph.getHistoricalLpTokenValuesBalancer(poolAddress, blocksOfInteraction);
    assert(liquidityData.length === blocksOfInteraction.length);

    const initialLiquidity = await graph.getLpTokenValueAtBlockBalancer(poolAddress, startBlock);

    return calculateVFromData(liquidityData, initialLiquidity, startBlock, endBlock);
}

function groupTransfersByAddress(transfers: Transfer[]) {
    const result: {[key:string]: Transfer[]} = {};
    
    transfers.forEach(tx => {
        if (result[tx.from] === undefined) result[tx.from] = [];
        if (result[tx.to] === undefined) result[tx.to] = [];

        result[tx.from].push(tx);
        result[tx.to].push(tx);
    });

    return result;
}

function calculateYp(_V: number[], transfers: Transfer[], allUserAddresses: string[], startBlock: number, endBlock: number): math.Matrix {
    function extendArray(arr: number[], val: number, n: number) {
        for (let i = 0; i < n; i++) {
            arr.push(val);
        }
    }


    const _Yp: number[] = [];
    const groupedTransfers = groupTransfersByAddress(transfers);

    let progress = 0;
    process.stdout.write(`Yp calculation progress: 0/${allUserAddresses.length}`);
    
    allUserAddresses.forEach(address => {
        progress++;
        const relevantTransfers = groupedTransfers[address];

        if (relevantTransfers === undefined) {
            // this address hasn't participated in this pool
            _Yp.push(0);
            return;
        }

        let balance = ethers.BigNumber.from('0');

        let i = 0;
        while (i < relevantTransfers.length && parseInt(relevantTransfers[i].blockNum) <= startBlock) {
            const tx = relevantTransfers[i];
            const value = ethers.BigNumber.from(tx.rawContract.value);

            if (tx.from === address) {
                balance = balance.sub(value);
                assert(balance.gte('0'));
            }

            if (tx.to === address) {
                balance = balance.add(value);
            }

            i++;
        }

        const _SRow: number[] = [Number(balance)];

        while (i < relevantTransfers.length && parseInt(relevantTransfers[i].blockNum) < endBlock) {
            const tx = relevantTransfers[i];
            const value = ethers.BigNumber.from(tx.rawContract.value);
            const blockNum = parseInt(tx.blockNum);

            extendArray(_SRow, Number(balance), blockNum - startBlock - _SRow.length);

            if (tx.from === address) {
                balance = balance.sub(value);
                assert(balance.gte('0'));
            }
            if (tx.to === address) {
                balance = balance.add(value);
            }

            i++;
        }

        extendArray(_SRow, Number(balance), endBlock - startBlock - _SRow.length);

        const yp = math.multiply(math.matrix(_SRow) as math.MathType, math.matrix(_V)) as number;
        
        _Yp.push(yp);

        consoleReplaceLine(`Yp calculation progress: ${progress}/${allUserAddresses.length}`);
    });

    consoleReplaceLine(`Yp calculation progress: ${progress}/${allUserAddresses.length}\n`);

    return math.matrix(_Yp);
}


function calculateS(transfers: Transfer[], addresses: string[], startBlock: number, endBlock: number) {
    /*
    PLAN

    recreate balances of all users at START_BLOCK by iterating over transfers
        - pause once START_BLOCK is reached

    use above balances to create first column of _S

    continue iteration over transfers
        - fill in columns between last filled column and current block's column with values of last filled in column (because state is unchanged during these blocks)
        - set column corresponding to current transfer block to current balances state

    return

    */

    const balances: {[key: string]: ethers.BigNumber} = {};

    function updateBalances(tx: Transfer) {
        const value = ethers.BigNumber.from(tx.rawContract.value);

        if (value.eq('0')) {
            return;
        }
        
        if (tx.from !== ZERO_ADDRESS) {
            balances[tx.from] = balances[tx.from].sub(value);
            assert(balances[tx.from].gte('0'));
            assert(addresses.indexOf(tx.from) !== -1);
        }
        
        if (tx.to !== ZERO_ADDRESS) {
            balances[tx.to] = balances[tx.to] || ethers.BigNumber.from('0');   
            balances[tx.to] = balances[tx.to].add(value);
            assert(addresses.indexOf(tx.to) !== -1);
        }
    }
    
    let i = 0;
    while (parseInt(transfers[i].blockNum) <= startBlock) {
        const tx = transfers[i];
        updateBalances(tx);
        i++;
    }

    const _S: number[][] = Array(addresses.length).fill([]);

    function fillColumns(numberToFill: number) {
        TIMING.fillingData.last = Date.now();
        const nCols = _S[0].length;
        // iterate over rows
        for (let _row = 0; _row < _S.length; _row++) {
            // fill in extra data for each column until we hit current block
            const v = _S[_row][nCols - 1];
            for (let _n = 0; _n < numberToFill; _n++) {
                _S[_row].push(v)
            }
        }
        TIMING.fillingData.total += Date.now() - TIMING.fillingData.last;
    }


    // create initial column
    for (let j = 0; j < addresses.length; j++) {
        _S[j] = [Number(balances[addresses[j]] || 0)];
    }

    process.stdout.write('filling _S matrix progress: 0%');

    let lastPct = 0;
    while (i < transfers.length && parseInt(transfers[i].blockNum) < endBlock) {
        const tx = transfers[i];
        const blockNo = parseInt(tx.blockNum);
        
        updateBalances(tx);

        const nCols = _S[0].length;
        if (blockNo - startBlock > nCols) {
            fillColumns(blockNo - startBlock - nCols);
        }

        for (let iAddr = 0; iAddr < addresses.length; iAddr++) {
            _S[iAddr].push(Number(balances[addresses[iAddr]] || 0));
        }

        // log progress
        const currPct = decimalToPercent(nCols / (endBlock - startBlock));
        if (currPct > lastPct) {
            consoleReplaceLine(`filling _S matrix progress: ${currPct}%`);
            lastPct = currPct;
        }
            
        i++;
    }

    const nCols = _S[0].length;
    if (endBlock - startBlock > nCols) {
        fillColumns(endBlock - startBlock - nCols);
    }

    consoleReplaceLine(`filling _S matrix progress: 100%\n`);

    return _S;
}


function getAllUserAddressesFromTransfers(transfers: Transfer[]): string[] {
    const addrs: string[] = [];
    transfers.forEach(tx => {
        if (tx.from !== ZERO_ADDRESS && addrs.indexOf(tx.from) === -1) {
            addrs.push(tx.from);
        }
        if (tx.to !== ZERO_ADDRESS && addrs.indexOf(tx.to) === -1) {
            addrs.push(tx.to);
        }
    });
    return addrs;
}

async function createBlockMapping(startBlock: number, endBlock: number) {
    const blocks = await graph.getBlocks(startBlock, endBlock);  

    blocks.forEach(x => {
        blockTimestampToNumber[x.timestamp] = x.number;
        blockNumberToTimestamp[x.number] = x.timestamp;
    });

}

function calculateDiversityMultipliersFromYVecs(yVecPerPool: {[key: string]: math.Matrix}): {[key: string]: math.Matrix} {
    const mVecPerPool: {[key: string]: math.Matrix} = {}; // holds Mp per pool
    const pools = Object.keys(yVecPerPool);
    for (let i = 0; i < pools.length; i++) {
        const _Yx = yVecPerPool[pools[i]];
        let _Mp = math.zeros(_Yx.size());
        // summation term
        for (let j = 0; j < pools.length; j++) {
            if (i === j) continue;
            let inner = math.dotDivide(yVecPerPool[pools[j]], _Yx) as math.Matrix;
            inner = inner.map(v => v === Infinity || isNaN(v) ? 0 : v);
            inner = inner.map(v => math.min(1, v));
            _Mp = math.add(_Mp, inner);
        }

        _Mp = math.multiply(DIVERSITY_BOOST_FACTOR, _Mp) as math.Matrix;

        _Mp = math.add(1, _Mp) as math.Matrix;

        mVecPerPool[pools[i]] = _Mp;
    }

    return mVecPerPool;
}

function calculateTimeMultipliers(transfers: Transfer[], addresses: string[], oldStacks: TimeDataStackMapping, startBlock: number): [number[], TimeDataStackMapping] {
    const newStacks: TimeDataStackMapping = {};
    const ans: number[] = [];

    const groupedTransfers = groupTransfersByAddress(transfers);

    addresses.forEach(address => {
        let newStackOfUser: TimeDataStack;
        let balance = ethers.BigNumber.from('0');

        if (oldStacks[address] === undefined) {
            newStackOfUser = [];
        }
        else {
            newStackOfUser = oldStacks[address].map(e => {
                return {
                    amount: e.amount,
                    multiplier: e.multiplier*TIME_BASE_MULTIPLIER
                }
            });

            balance = oldStacks[address].reduce((prev, curr) => prev.add(curr.amount), ethers.BigNumber.from('0'));
        }

        if (groupedTransfers[address] !== undefined) {
            groupedTransfers[address].forEach(tx => {
                let value = ethers.BigNumber.from(tx.rawContract.value);
                
                if (parseInt(tx.blockNum) < startBlock || value.eq('0')) return;

                if (tx.to === address) {
                    // user deposited
                    // add to stack
                    newStackOfUser.push({
                        amount: value,
                        multiplier: 1
                    });
                }
                else if (tx.from === address) {
                    // user withdrew
                    // work down the stack

                    // debugging sanity check - value withdrawn is less than or equal to amount reflected in stack
                    assert(value.lte(newStackOfUser.reduce((prev, curr) => prev.add(curr.amount), ethers.BigNumber.from('0'))));

                    while (value.gt('0')) {
                        const topElement = newStackOfUser[newStackOfUser.length - 1];
                        const topElementAmount = topElement.amount;
                        
                        if (topElementAmount.lte(value)) {
                            newStackOfUser.pop();
                        }
                        else {
                            topElement.amount = topElement.amount.sub(value);
                            assert(topElement.amount.gt('0'));
                            break; // redundant
                        }

                        value = value.sub(topElementAmount);
                    }
                }
            });
        }

        newStacks[address] = newStackOfUser;

        const finalBalance = newStackOfUser.reduce((prev, curr) => prev.add(curr.amount), ethers.BigNumber.from('0'));
        
        assert(finalBalance.gte('0'));
        const multiplierForThisUser = finalBalance.eq('0') ? 
            1
            : 
            newStackOfUser.reduce((prev, curr) => prev + Number(ethers.BigNumber.from(curr.amount))*curr.multiplier, 0) / Number(finalBalance);
        
        assert(multiplierForThisUser >= 1, multiplierForThisUser + '');

        ans.push(multiplierForThisUser);
    });

    return [ans, newStacks];
}

function generateFreshTimeMultiplierStacks(transfers: Transfer[], addresses: string[]): TimeDataStackMapping {
    const ans: {[key: string]: TimeDataStack} = {};
    const groupedTransfers = groupTransfersByAddress(transfers);

    Object.entries(groupedTransfers).forEach(entry => {
        const address = entry[0];
        const txs = entry[1];

        if (address === ZERO_ADDRESS) return;

        // find final balance of this address
        let amt = ethers.BigNumber.from('0');
        txs.forEach(tx => {
            if (tx.to === address) {
                amt = amt.add(tx.rawContract.value);
            }
            else {
                amt = amt.sub(tx.rawContract.value);
                assert(amt.gte('0'), address);
            }
        });

        ans[address] = [{
            amount: amt,
            multiplier: 1
        }];
    });

    return ans;
}


function getTimeMultiplierRecordFilePath(poolAddress: string, endBlock: number): string {
    return `${TIME_MULTIPLIER_RECORDS_DIRECTORY}/${poolAddress}-${endBlock}.json`
}

function saveTimeMultiplierRecord(poolAddress: string, endBlock: number, stacks: TimeDataStackMapping) {
    if (!fs.existsSync(TIME_MULTIPLIER_RECORDS_DIRECTORY)) {
        fs.mkdirSync(TIME_MULTIPLIER_RECORDS_DIRECTORY);
    }
    
    return fsAsync.writeFile(getTimeMultiplierRecordFilePath(poolAddress, endBlock), JSON.stringify(stacks));
}

function writeReport(payoutMatrix: math.Matrix, userAddresses: string[], startBlock: number, endBlock: number) {
    assert(payoutMatrix.size().length === 1 && payoutMatrix.size()[0] === userAddresses.length);
    const payoutArray = payoutMatrix.toArray() as number[];

    let s = '';
    for (let i = 0; i < userAddresses.length; i++) {
        const trunced = truncateDecimal(payoutArray[i], DECIMALS);
        if (trunced > 0) {
            s += `${userAddresses[i]},${trunced}\n`;
        }
    }

    if (!fs.existsSync(REPORTS_DIRECTORY)) {
        fs.mkdirSync(REPORTS_DIRECTORY);
    }

    return fsAsync.writeFile(`${REPORTS_DIRECTORY}/${startBlock}-${endBlock}.csv`, s);
}

(async () => {
    TIMING.scriptStart = Date.now();

    // get all erc20 transfer data
    process.stdout.write('Fetching LP token transfers...');
    const erc20TransfersByPool = await alchemy.getTransfersOfPools(POOLS.map(p => p.address), 0, END_BLOCK);
    process.stdout.write('Done!\n');

    // build master list of users
    const allUserAddresses = getAllUserAddressesFromTransfers(Array.prototype.concat(...Object.values(erc20TransfersByPool)));

    // create mapping between block timestamp and number
    await createBlockMapping(START_BLOCK, END_BLOCK);

    const yVecPerPool: {[key: string]: math.Matrix} = {};
    const tVecPerPool: {[key: string]: math.Matrix} = {};

    for (let i = 0; i < POOLS.length; i++) {
        const pool = POOLS[i];
        // calculate _V
        let _V: number[];
        if (pool.protocol === "balancer") {
            _V = await calculateVBalancer(pool.address, START_BLOCK, END_BLOCK);
            await testVBalancer(_V, pool.address, START_BLOCK, END_BLOCK);
        }
        else {
            throw new Error("Invalid protocol");
        }

        const _Yp = calculateYp(_V, erc20TransfersByPool[pool.address], allUserAddresses, START_BLOCK, END_BLOCK);

        yVecPerPool[pool.address] = _Yp;

        // create time multiplier vector
        let tVec: number[];
        let newStacks: TimeDataStackMapping;
        if (!RESET_TIME && fs.existsSync(getTimeMultiplierRecordFilePath(pool.address, START_BLOCK))) {
            // we're using records from the previous run 
            const oldStacks = require(getTimeMultiplierRecordFilePath(pool.address, START_BLOCK));
            [tVec, newStacks] = calculateTimeMultipliers(erc20TransfersByPool[pool.address], allUserAddresses, oldStacks, START_BLOCK);
        }
        else {
            console.warn('Not using old time multiplier data.');
            tVec = Array(allUserAddresses.length).fill(1);
            newStacks = generateFreshTimeMultiplierStacks(erc20TransfersByPool[pool.address], allUserAddresses);
        }

        tVecPerPool[pool.address] = math.matrix(tVec);

        // save time multipliers for later runs
        await saveTimeMultiplierRecord(pool.address, END_BLOCK, newStacks);
    }

    // create diversity multiplier vectors
    const dVecPerPool = calculateDiversityMultipliersFromYVecs(yVecPerPool);
    testDiversity(yVecPerPool, dVecPerPool, DIVERSITY_BOOST_FACTOR);

    // calculate _F (with diversity and time boosts)
    let _F = math.zeros(Object.values(yVecPerPool)[0].size());
    for (let i = 0; i < POOLS.length; i++) {
        const _Yp = yVecPerPool[POOLS[i].address];
        const _Dp = dVecPerPool[POOLS[i].address];
        const _Tp = tVecPerPool[POOLS[i].address];

        const YD = math.dotMultiply(_Yp, _Dp);
        const YDT = math.dotMultiply(YD, _Tp);

        _F = math.add(_F, YDT) as math.Matrix;
    }

    const normalizedF = math.multiply(1 / math.sum(_F), _F) as math.Matrix;
    assert(Math.abs(math.sum(normalizedF) - 1) < 1e-8);

    const calculatedIncentives = math.multiply(INCENTIVES, normalizedF) as math.Matrix;

    await writeReport(calculatedIncentives, allUserAddresses, START_BLOCK, END_BLOCK);
    
    console.log(`finished in ${Math.floor((Date.now() - TIMING.scriptStart)/1000)} seconds`);
})();