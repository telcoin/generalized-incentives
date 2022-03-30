import * as math from 'mathjs';

const DIVERSITY_BASE_MULTIPLIER = 0.5;

function calculateDiversityMultiplierFromYVecs(yVecPerPool: {[key: string]: math.Matrix}): {[key: string]: math.Matrix} {
    const mVecPerPool: {[key: string]: math.Matrix} = {}; // holds Mp per pool
    const pools = Object.keys(yVecPerPool);
    for (let i = 0; i < pools.length; i++) {
        const _Yx = yVecPerPool[pools[i]]
        let _Mp = math.zeros(_Yx.size());
        // summation term
        for (let j = 0; j < pools.length; j++) {
            if (i === j) continue;
            let inner = math.dotDivide(yVecPerPool[pools[j]], _Yx) as math.Matrix;
            inner = inner.map(v => math.min(1, v));
            _Mp = math.add(_Mp, inner);
        }

        _Mp = math.multiply(DIVERSITY_BASE_MULTIPLIER, _Mp) as math.Matrix;

        _Mp = math.add(1, _Mp) as math.Matrix;

        mVecPerPool[pools[i]] = _Mp;
    }

    return mVecPerPool;
}

const yVecPerPool = {
    "a": math.matrix([1,2]),
    "b": math.matrix([10, 2])
};

console.log(calculateDiversityMultiplierFromYVecs(yVecPerPool))