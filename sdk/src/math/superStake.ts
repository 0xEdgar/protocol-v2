import {
	AddressLookupTableAccount,
	LAMPORTS_PER_SOL,
	PublicKey,
	TransactionInstruction,
} from '@solana/web3.js';
import { JupiterClient } from '../jupiter/jupiterClient';
import { DriftClient } from '../driftClient';
import { getMarinadeFinanceProgram, getMarinadeMSolPrice } from '../marinade';
import { BN } from '@coral-xyz/anchor';
import { User } from '../user';
import { DepositRecord, isVariant } from '../types';
import { LAMPORTS_PRECISION, ZERO } from '../constants/numericConstants';
import fetch from 'node-fetch';

export async function findBestSuperStakeIxs({
	amount,
	jupiterClient,
	driftClient,
	userAccountPublicKey,
	marinadePrice,
	forceMarinade,
	onlyDirectRoutes,
}: {
	amount: BN;
	jupiterClient: JupiterClient;
	driftClient: DriftClient;
	marinadePrice?: number;
	userAccountPublicKey?: PublicKey;
	forceMarinade?: boolean;
	onlyDirectRoutes?: boolean;
}): Promise<{
	ixs: TransactionInstruction[];
	lookupTables: AddressLookupTableAccount[];
	method: 'jupiter' | 'marinade';
	price: number;
}> {
	if (!marinadePrice) {
		const marinadeProgram = getMarinadeFinanceProgram(driftClient.provider);
		marinadePrice = await getMarinadeMSolPrice(marinadeProgram);
	}

	const solMint = driftClient.getSpotMarketAccount(1).mint;
	const mSOLMint = driftClient.getSpotMarketAccount(2).mint;

	let jupiterPrice;
	let bestRoute;
	try {
		const jupiterRoutes = await jupiterClient.getRoutes({
			inputMint: solMint,
			outputMint: mSOLMint,
			amount,
			onlyDirectRoutes,
		});

		bestRoute = jupiterRoutes[0];
		jupiterPrice = bestRoute.inAmount / bestRoute.outAmount;
	} catch (e) {
		console.error('Error getting jupiter price', e);
	}

	if (!jupiterPrice || marinadePrice <= jupiterPrice || forceMarinade) {
		const ixs = await driftClient.getStakeForMSOLIx({
			amount,
			userAccountPublicKey,
		});
		return {
			method: 'marinade',
			ixs,
			lookupTables: [],
			price: marinadePrice,
		};
	} else {
		const { ixs, lookupTables } = await driftClient.getJupiterSwapIx({
			inMarketIndex: 1,
			outMarketIndex: 2,
			route: bestRoute,
			jupiterClient,
			amount,
			userAccountPublicKey,
		});
		return {
			method: 'jupiter',
			ixs,
			lookupTables,
			price: jupiterPrice,
		};
	}
}

export async function calculateSolEarned({
	user,
	depositRecords,
}: {
	user: User;
	depositRecords: DepositRecord[];
}): Promise<BN> {
	const now = Date.now() / 1000;
	const timestamps: number[] = [
		now,
		...depositRecords.map((r) => r.ts.toNumber()),
	];

	const msolRatios = new Map<number, number>();

	const getPrice = async (timestamp) => {
		const date = new Date(timestamp * 1000); // Convert Unix timestamp to milliseconds
		const swaggerApiDateTime = date.toISOString(); // Format date as swagger API date-time
		const url = `https://api.marinade.finance/msol/price_sol?time=${swaggerApiDateTime}`;
		const response = await fetch(url);
		if (response.status === 200) {
			const data = await response.json();
			msolRatios.set(timestamp, data);
		}
	};

	await Promise.all(timestamps.map(getPrice));

	let solEarned = ZERO;
	for (const record of depositRecords) {
		if (record.marketIndex === 1) {
			if (isVariant(record.direction, 'deposit')) {
				solEarned = solEarned.sub(record.amount);
			} else {
				solEarned = solEarned.add(record.amount);
			}
		} else if (record.marketIndex === 2) {
			const msolRatio = msolRatios.get(record.ts.toNumber());
			const msolRatioBN = new BN(msolRatio * LAMPORTS_PER_SOL);

			const solAmount = record.amount.mul(msolRatioBN).div(LAMPORTS_PRECISION);
			if (isVariant(record.direction, 'deposit')) {
				solEarned = solEarned.sub(solAmount);
			} else {
				solEarned = solEarned.add(solAmount);
			}
		}
	}

	const currentMSOLTokenAmount = await user.getTokenAmount(2);
	const currentSOLTokenAmount = await user.getTokenAmount(1);

	const currentMSOLRatio = msolRatios.get(now);
	const currentMSOLRatioBN = new BN(currentMSOLRatio * LAMPORTS_PER_SOL);

	solEarned = solEarned.add(
		currentMSOLTokenAmount.mul(currentMSOLRatioBN).div(LAMPORTS_PRECISION)
	);
	solEarned = solEarned.add(currentSOLTokenAmount);

	return solEarned;
}

// calculate estimated liquidation price (in mSOL/SOL) based on target amounts
export function calculateEstimatedSuperStakeLiquidationPrice(
	msolDepositAmount: number,
	msolMaintenanceAssetWeight: number,
	solBorrowAmount: number,
	solMaintenanceLiabilityWeight: number,
	msolPriceRatio: number
): number {
	const liquidationDivergence =
		(solMaintenanceLiabilityWeight * solBorrowAmount) /
		(msolMaintenanceAssetWeight * msolDepositAmount * msolPriceRatio);
	const liquidationPrice = msolPriceRatio * liquidationDivergence;
	return liquidationPrice;
}
