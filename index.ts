import * as dotenv from 'dotenv';
dotenv.config();

import { assert } from 'chai';

import { ethers } from 'ethers';

import * as math from 'mathjs';

import * as alchemy from './api/alchemy';
import * as balancerContracts from './api/balancerContracts';
import { HistoricalTokenValue, Transfer } from './api/types';

import * as graph from './api/graph';
import { testDiversity, testVBalancer } from './helpers/testingHelper';

import * as fsAsync from 'fs/promises';
import * as fs from 'fs';
import { consoleReplaceLine, decimalToPercent, truncateDecimal } from './helpers/misc';
import * as polygonscan from './api/polygonscan';
import path from 'path';

const POOLS: Pool[] = [
    {
        symbol: "TEL/LINK",
        address: "0x82dB37683832A36F1B5C2863D7f9c4438DED4093".toLowerCase(),
    },
    {
        symbol: "TEL/MANA",
        address: "0xA2c0539CF5a8a930215d82106d8973a2031f7FB3".toLowerCase(),
    },
    {
        symbol: "TEL/APE",
        address: "0x385Fd3414AfB52D5cD60E22f17826cF992060244".toLowerCase(),
    },
    {
        symbol: "TEL/CRV",
        address: "0xfA73E062497b0cbD5012385A08D9616cA5BD9Ee9".toLowerCase(),
    },
    {
        symbol: "TEL/MKR",
        address: "0xC42C42256B484E574A458d5D8EE4fD7876F6d8D7".toLowerCase(),
    },
    {
        symbol: "TEL/AXS",
        address: "0x913b9Ae6d6a228A38fbF2310e176C6ea82E57611".toLowerCase(),
    },
    {
        symbol: "TEL/UNI",
        address: "0x77215a7E8a8D427D25660414788d2C58dd568989".toLowerCase(),
    },
    {
        symbol: "TEL/GRT",
        address: "0x0a2b8a82fFdf39AcCe59729f6285BAF530a13c53".toLowerCase(),
    },
    {
        symbol: "TEL/SOL",
        address: "0xffbb77fb2725b5c227dd2879d813587a30c5359c".toLowerCase(),
    },
    {
        symbol: "TEL/GHST",
        address: "0x7b90ae8aacf98cb872e5f1cc8e729241c5b8e44d".toLowerCase(),
    },
    {
        symbol: "TEL/SAND",
        address: "0x6ff633d7eaafe1f6e4c6f0280317b93125aaa7eb".toLowerCase(),
    },
];


const PERIOD_START_TS = Math.floor(new Date(Date.UTC(2022, 10, 5)).getTime()/1000);
const SUPER_PERIOD_START_TS = PERIOD_START_TS;//Math.floor(new Date(Date.UTC(2022, 9, 6)).getTime()/1000);
const PERIOD_END_TS = Math.floor(new Date(Date.UTC(2022, 11, 5)).getTime()/1000);

const SECONDS_PER_WEEK = 604800;

const TOTAL_INCENTIVES_PER_PERIOD = 20_000_000;
const DECIMALS = 2;

const DIVERSITY_MAX_MULTIPLIER = 1.5;
const DIVERSITY_BOOST_FACTOR = (DIVERSITY_MAX_MULTIPLIER - 1) / (POOLS.length - 1);

const TIME_BASE_MULTIPLIER = 1.05

const TIME_MULTIPLIER_RECORDS_DIRECTORY = './timeMultiplierRecords';
const REPORTS_DIRECTORY = './reports';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const blockTimestampToNumber: {[key: string]: string} = {};
const blockNumberToTimestamp: {[key: string]: string} = {};

type Pool = {
    symbol: string,
    address: string
};

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
    if (liquidityData.length === 0) {
        return Array(endBlock - startBlock).fill(liquidityValueAtStartBlock);
    }
    
    liquidityData.sort((a, b) => {
        return a.block - b.block;
    });

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

// async function calculateVBalancer2()

async function calculateVBalancer(poolAddress: string, startBlock: number, endBlock: number): Promise<number[]> {
    // to get liquidity data, we first need to get blocks where swaps, adds, or removeds occur
    // get swaps
    const swapTimestamps = await graph.getSwapsTimestampsBalancer(
        poolAddress, 
        blockNumberToTimestamp[startBlock], 
        blockNumberToTimestamp[endBlock]
    );

    // new method using events
    
    
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
    const liquidityData = await balancerContracts.getLptValuesAtManyBlocks(poolAddress, blocksOfInteraction);
    // const liquidityData = await graph.getHistoricalLpTokenValuesBalancer(poolAddress, blocksOfInteraction);
    assert(liquidityData.length === blocksOfInteraction.length);

    const initialLiquidity = await balancerContracts.getLptValueAtBlock(poolAddress, startBlock);
    // const initialLiquidity = await graph.getLpTokenValueAtBlockBalancer(poolAddress, startBlock);
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

function calculateTimeMultipliers(transfers: Transfer[], addresses: string[], oldStacks: TimeDataStackMapping, startBlock: number, endBlock: number): [number[], TimeDataStackMapping] {
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
                    amount: ethers.BigNumber.from(e.amount),
                    multiplier: e.multiplier*TIME_BASE_MULTIPLIER
                }
            });

            balance = oldStacks[address].reduce((prev, curr) => prev.add(curr.amount), ethers.BigNumber.from('0'));
        }

        if (groupedTransfers[address] !== undefined) {
            groupedTransfers[address].forEach(tx => {
                let value = ethers.BigNumber.from(tx.rawContract.value);
                
                if (Number(tx.blockNum) < startBlock || Number(tx.blockNum) >= endBlock || value.eq('0')) return;

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
        
        assert(multiplierForThisUser >= .999, multiplierForThisUser + '');

        ans.push(multiplierForThisUser);
    });

    return [ans, newStacks];
}

function generateFreshTimeMultiplierStacks(transfers: Transfer[], endBlock: number): TimeDataStackMapping {
    const ans: {[key: string]: TimeDataStack} = {};
    const groupedTransfers = groupTransfersByAddress(transfers);

    Object.entries(groupedTransfers).forEach(entry => {
        const address = entry[0];
        const txs = entry[1];

        if (address === ZERO_ADDRESS) return;

        // find final balance of this address
        let amt = ethers.BigNumber.from('0');
        txs.forEach(tx => {
            if (Number(tx.blockNum) >= endBlock) return;

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

function writeReport(payoutMatrix: math.Matrix, userAddresses: string[], startTs: number, endTs: number) {
    assert(payoutMatrix.size().length === 1 && payoutMatrix.size()[0] === userAddresses.length);
    const payoutArray = payoutMatrix.toArray() as number[];

    let s = '';
    for (let i = 0; i < userAddresses.length; i++) {
        const trunced = truncateDecimal(payoutArray[i], DECIMALS);
        if (trunced > 0) {
            s += `erc20,0xdF7837DE1F2Fa4631D716CF2502f8b230F1dcc32,${userAddresses[i]},${trunced}\n`;
        }
    }

    if (!fs.existsSync(REPORTS_DIRECTORY)) {
        fs.mkdirSync(REPORTS_DIRECTORY);
    }

    return fsAsync.writeFile(`${REPORTS_DIRECTORY}/${startTs}-${endTs}.csv`, s);
}

function writeCumulativeReport(payoutMatrix: math.Matrix, userAddresses: string[], endTs: number) {
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

    return fsAsync.writeFile(`${REPORTS_DIRECTORY}/cumulative-${endTs}.csv`, s);
}

async function calculateIncentivesForOneWeek(
    pools: Pool[],
    erc20TransfersByPool: {[key: string]: Transfer[]},
    allUserAddresses: string[],
    timeDataStacks: {[key:string]: TimeDataStackMapping}, 
    startTs: number, 
    endTs: number
) {
    // get start and end blocks
    const startBlock = await polygonscan.getBlockNumberByTimestamp(startTs);
    const endBlock = await polygonscan.getBlockNumberByTimestamp(endTs);

    // calculate how much incentives to allocate this round
    const incentivesForThisWeek = TOTAL_INCENTIVES_PER_PERIOD * (endTs - startTs) / (PERIOD_END_TS - PERIOD_START_TS);

    const yVecPerPool: {[key: string]: math.Matrix} = {};
    const tVecPerPool: {[key: string]: math.Matrix} = {};

    const newTimeDataStacksPerPool: {[key:string]: TimeDataStackMapping} = {};

    for (let i = 0; i < pools.length; i++) {
        const pool = pools[i];

        // calculate _V
        let _V: number[];
        _V = await calculateVBalancer(pool.address, startBlock, endBlock);
        // await testVBalancer(_V, pool.address, startBlock, endBlock);

        const _Yp = calculateYp(_V, erc20TransfersByPool[pool.address], allUserAddresses, startBlock, endBlock);

        yVecPerPool[pool.address] = _Yp;

        // create time multiplier vector
        let tVec: number[];
        let newStacks: TimeDataStackMapping;
        if (timeDataStacks[pool.address] !== undefined) {
            // we're using records from the previous run 
            [tVec, newStacks] = calculateTimeMultipliers(erc20TransfersByPool[pool.address], allUserAddresses, timeDataStacks[pool.address], startBlock, endBlock);
        }
        else {
            console.warn('Not using old time multiplier data.');
            tVec = Array(allUserAddresses.length).fill(1);
            newStacks = generateFreshTimeMultiplierStacks(erc20TransfersByPool[pool.address], endBlock);
        }

        tVecPerPool[pool.address] = math.matrix(tVec);
        newTimeDataStacksPerPool[pool.address] = newStacks;
    }

    // create diversity multiplier vectors
    const dVecPerPool = calculateDiversityMultipliersFromYVecs(yVecPerPool);
    testDiversity(yVecPerPool, dVecPerPool, DIVERSITY_BOOST_FACTOR);

    // calculate _F (with diversity and time boosts)
    let _F = math.zeros(Object.values(yVecPerPool)[0].size());
    for (let i = 0; i < pools.length; i++) {
        const _Yp = yVecPerPool[pools[i].address];
        const _Dp = dVecPerPool[pools[i].address];
        const _Tp = tVecPerPool[pools[i].address];

        const YD = math.dotMultiply(_Yp, _Dp);
        const YDT = math.dotMultiply(YD, _Tp);

        _F = math.add(_F, YDT) as math.Matrix;
    }

    const normalizedF = math.multiply(1 / math.sum(_F), _F) as math.Matrix;
    assert(Math.abs(math.sum(normalizedF) - 1) < 1e-8);

    const calculatedIncentives = math.multiply(incentivesForThisWeek, normalizedF) as math.Matrix;

    return {calculatedIncentives, newTimeDataStacksPerPool};
}

function secondsToDateString(d: number) {
    return new Date(d*1000).toISOString().split("T")[0];
}

(async () => {
    TIMING.scriptStart = Date.now();

    if (new Date(PERIOD_END_TS*1000) > new Date()) {
        console.log("Period has not ended yet");
        return;
    }

    const superPeriodStartBlock = await polygonscan.getBlockNumberByTimestamp(SUPER_PERIOD_START_TS);
    const periodEndBlock = await polygonscan.getBlockNumberByTimestamp(PERIOD_END_TS);

    // get all erc20 transfer data
    process.stdout.write('Fetching LP token transfers...');
    const erc20TransfersByPool = await alchemy.getTransfersOfPools(POOLS.map(p => p.address), 0, -1);
    process.stdout.write('Done!\n');

    // build master list of users
    const allUserAddresses = getAllUserAddressesFromTransfers(Array.prototype.concat(...Object.values(erc20TransfersByPool)));

    // create mapping between block timestamp and number
    await createBlockMapping(superPeriodStartBlock, periodEndBlock);

    console.log(superPeriodStartBlock, periodEndBlock, PERIOD_END_TS);

    ////////////////////////////////////////
    
    let weekStartTs = SUPER_PERIOD_START_TS;
    let weekEndTs = weekStartTs;

    let lastWeekTimeDataStacks: {[key:string]: TimeDataStackMapping} = {};
    let calculatedIncentives = math.zeros([allUserAddresses.length]) as math.Matrix;

    while (weekEndTs < PERIOD_END_TS) {
        // let x: math.Matrix;
        weekStartTs = weekEndTs;
        weekEndTs += SECONDS_PER_WEEK;
        weekEndTs = Math.min(weekEndTs, PERIOD_END_TS);

        console.log(`\nCalculating round ${secondsToDateString(weekStartTs)} - ${secondsToDateString(weekEndTs)}\n`)

        let output = await calculateIncentivesForOneWeek(
            POOLS,
            erc20TransfersByPool,
            allUserAddresses,
            lastWeekTimeDataStacks,
            weekStartTs,
            weekEndTs
        );

        lastWeekTimeDataStacks = output.newTimeDataStacksPerPool;
        calculatedIncentives = math.add(calculatedIncentives, output.calculatedIncentives);
    }

    await writeCumulativeReport(calculatedIncentives, allUserAddresses, PERIOD_END_TS);

    if (PERIOD_START_TS > SUPER_PERIOD_START_TS) {
        // this is not the first period within superperiod, therefore we must subtract last cumulative calculation
        const lastCumulativeText = (await fsAsync.readFile(path.join(REPORTS_DIRECTORY, `cumulative-${PERIOD_START_TS}.csv`))).toString();
        const lastCumulativeMap: {[key: string]: number} = {};

        lastCumulativeText.split('\n').forEach(line => {
            lastCumulativeMap[line.split(',')[0]] = Number(line.split(',')[1]);
        });

        const lastCumulativeArray: number[] = [];

        for (let i = 0; i < allUserAddresses.length; i++) {
            lastCumulativeArray.push(lastCumulativeMap[allUserAddresses[i]] || 0);
        }

        calculatedIncentives = math.subtract(calculatedIncentives, math.matrix(lastCumulativeArray));
    }

    await writeReport(calculatedIncentives, allUserAddresses, PERIOD_START_TS, PERIOD_END_TS);
})();
