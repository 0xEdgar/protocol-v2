import { TxSigAndSlot } from './types';
import {
	ConfirmOptions,
	Signer,
	Transaction,
	TransactionSignature,
	Connection,
	VersionedTransaction,
	TransactionMessage,
	TransactionInstruction,
	AddressLookupTableAccount,
} from '@solana/web3.js';
import { AnchorProvider } from '@coral-xyz/anchor';
import { IWallet } from '../types';
import { BaseTxSender } from './baseTxSender';

const DEFAULT_TIMEOUT = 35000;
const DEFAULT_BLOCKHASH_REFRESH = 10000;

export class FastSingleTxSender extends BaseTxSender {
	connection: Connection;
	wallet: IWallet;
	opts: ConfirmOptions;
	timeout: number;
	blockhashRefreshInterval: number;
	additionalConnections: Connection[];
	timoutCount = 0;
	recentBlockhash: string;

	public constructor({
		connection,
		wallet,
		opts = AnchorProvider.defaultOptions(),
		timeout = DEFAULT_TIMEOUT,
		blockhashRefreshInterval = DEFAULT_BLOCKHASH_REFRESH,
		additionalConnections = new Array<Connection>(),
	}: {
		connection: Connection;
		wallet: IWallet;
		opts?: ConfirmOptions;
		timeout?: number;
		blockhashRefreshInterval?: number;
		additionalConnections?;
	}) {
		super({ connection, wallet, opts, timeout, additionalConnections });
		this.connection = connection;
		this.wallet = wallet;
		this.opts = opts;
		this.timeout = timeout;
		this.blockhashRefreshInterval = blockhashRefreshInterval;
		this.additionalConnections = additionalConnections;
		this.startBlockhashRefreshLoop();
	}

	startBlockhashRefreshLoop(): void {
		setInterval(async () => {
			this.recentBlockhash = (
				await this.connection.getLatestBlockhash(this.opts)
			).blockhash;
		}, this.blockhashRefreshInterval);
	}

	async prepareTx(
		tx: Transaction,
		additionalSigners: Array<Signer>,
		opts: ConfirmOptions
	): Promise<Transaction> {
		tx.feePayer = this.wallet.publicKey;

		tx.recentBlockhash =
			this.recentBlockhash ??
			(await this.connection.getLatestBlockhash(opts.preflightCommitment))
				.blockhash;

		additionalSigners
			.filter((s): s is Signer => s !== undefined)
			.forEach((kp) => {
				tx.partialSign(kp);
			});

		const signedTx = await this.wallet.signTransaction(tx);

		return signedTx;
	}

	async getVersionedTransaction(
		ixs: TransactionInstruction[],
		lookupTableAccounts: AddressLookupTableAccount[],
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions
	): Promise<VersionedTransaction> {
		if (additionalSigners === undefined) {
			additionalSigners = [];
		}
		if (opts === undefined) {
			opts = this.opts;
		}

		const message = new TransactionMessage({
			payerKey: this.wallet.publicKey,
			recentBlockhash:
				this.recentBlockhash ??
				(await this.connection.getLatestBlockhash(opts.preflightCommitment))
					.blockhash,
			instructions: ixs,
		}).compileToV0Message(lookupTableAccounts);

		const tx = new VersionedTransaction(message);

		return tx;
	}

	async sendRawTransaction(
		rawTransaction: Buffer | Uint8Array,
		opts: ConfirmOptions
	): Promise<TxSigAndSlot> {
		let txid: TransactionSignature;
		try {
			txid = await this.connection.sendRawTransaction(rawTransaction, opts);
			this.sendToAdditionalConnections(rawTransaction, opts);
		} catch (e) {
			console.error(e);
			throw e;
		}

		this.connection.sendRawTransaction(rawTransaction, opts).catch((e) => {
			console.error(e);
		});
		this.sendToAdditionalConnections(rawTransaction, opts);

		let slot: number;
		try {
			const result = await this.confirmTransaction(txid, opts.commitment);
			slot = result.context.slot;
		} catch (e) {
			console.error(e);
			throw e;
		}

		return { txSig: txid, slot };
	}
}
