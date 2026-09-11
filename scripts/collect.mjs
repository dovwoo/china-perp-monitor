import { readFile, rename, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
//#region lib/market.ts
var number = (x) => x === null || x === void 0 || x === "" || !Number.isFinite(Number(x)) ? null : Number(x);
function oiNotional(quantity, price, multiplier = 1) {
	const q = number(quantity), p = number(price), m = number(multiplier);
	return q !== null && q >= 0 && p !== null && p > 0 && m !== null && m > 0 ? q * p * m : null;
}
var stateLabel = (r) => r.reason.includes("减仓") ? "只可减仓" : r.venue === "bitmart" && r.directory_open ? "成交待确认" : r.directory_open ? "目录正常" : r.status === "missing" ? "目录未找到" : r.reason || "暂停 / 下架";
var stale = (time, now = Date.now()) => !time || now - Date.parse(time) > 900 * 1e3;
var endpoints = {
	gate: "https://api.gateio.ws/api/v4/futures/usdt/contracts",
	binance: "https://fapi.binance.com/fapi/v1/exchangeInfo",
	bybit: "https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000",
	bitget: "https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES",
	mexc: "https://contract.mexc.com/api/v1/contract/detail",
	kucoin: "https://api-futures.kucoin.com/api/v1/contracts/active",
	okx: "https://www.okx.com/api/v5/public/instruments?instType=SWAP",
	htx: "https://api.hbdm.com/linear-swap-api/v1/swap_contract_info",
	xt: "https://fapi.xt.com/future/market/v1/public/symbol/list",
	aster: "https://fapi.asterdex.com/fapi/v1/exchangeInfo",
	hyperliquid_xyz: "https://api.hyperliquid.xyz/info",
	lighter: "https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails",
	bitmart: "https://api-cloud-v2.bitmart.com/contract/public/details"
};
function directory(venue, d) {
	let rows;
	if (venue === "gate") rows = d;
	else if (["binance", "aster"].includes(venue)) rows = d.symbols;
	else if (venue === "bybit") rows = d.retCode === 0 ? d.result?.list : null;
	else if (venue === "hyperliquid_xyz") rows = d[0]?.universe;
	else if (venue === "lighter") rows = d.code === 200 ? d.order_book_details : null;
	else if (venue === "bitmart") rows = d.code === 1e3 ? d.data?.symbols : null;
	else if (venue === "xt") rows = d.returnCode === 0 ? d.result : null;
	else if (venue === "mexc") rows = d.success ? d.data : null;
	else if (venue === "okx") rows = d.code === "0" ? d.data : null;
	else if (venue === "bitget") rows = d.code === "00000" ? d.data : null;
	else if (venue === "kucoin") rows = d.code === "200000" ? d.data : null;
	else if (venue === "htx") rows = d.status === "ok" ? d.data : null;
	if (!Array.isArray(rows) || rows.length < 3) throw Error("目录为空或返回格式异常");
	if (rows.some((x) => !x || typeof x !== "object" || typeof symbolOf(venue, x) !== "string" || !symbolOf(venue, x))) throw Error("目录字段不完整");
	return rows;
}
var symbolOf = (v, x) => v === "htx" ? x.contract_code : x.symbol ?? x.name ?? x.instId;
function normalizeStatus(v, x, r) {
	const status = v === "hyperliquid_xyz" ? x.isDelisted ? "delisted" : "active" : x.status ?? x.state ?? x.symbolStatus ?? x.contract_status ?? "unknown";
	let open = status === {
		gate: "trading",
		binance: "TRADING",
		bybit: "Trading",
		bitget: "normal",
		mexc: 0,
		kucoin: "Open",
		okx: "live",
		htx: 1,
		xt: 0,
		aster: "TRADING",
		hyperliquid_xyz: "active",
		lighter: "active",
		bitmart: "Trading"
	}[v], reason = open ? "" : "暂停 / 下架";
	if (v === "gate" && (x.in_delisting || x.is_pre_market && r.layer === "已上市公司")) {
		open = false;
		reason = "下架中 / 预市场";
	}
	if (v === "bitget" && Number(x.limitOpenTime) > 0 && Number(x.limitOpenTime) <= Date.now()) {
		open = false;
		reason = "停止开仓时间已到";
	}
	if (v === "bybit" && x.isPreListing) {
		open = false;
		reason = "预上市阶段";
	}
	if (v === "xt" && (!x.tradeSwitch || !x.openSwitch)) {
		open = false;
		reason = "交易 / 开仓开关关闭";
	}
	if (v === "lighter" && x.market_config?.force_reduce_only) {
		open = false;
		reason = "只可减仓";
	}
	if (v === "bitmart" && x.reduce_only) {
		open = false;
		reason = "只可减仓";
	}
	if (v === "binance" && x.filters?.some((f) => f.positionControlSide && f.positionControlSide !== "NONE")) {
		open = false;
		reason = "方向持仓限制";
	}
	return {
		status,
		directory_open: open,
		reason
	};
}
function metrics(v, x, t, at) {
	const n = number, q = t || x;
	let price = null, volume = null, oi = null, funding = null, interval = null, nextFunding = null, bid = null, ask = null, change = null;
	if (v === "gate") {
		price = n(q.mark_price);
		volume = n(t?.volume_24h_settle);
		oi = oiNotional(x.position_size, price, x.quanto_multiplier ?? null);
		funding = n(x.funding_rate);
		interval = n(x.funding_interval) !== null ? Number(x.funding_interval) / 3600 : null;
		nextFunding = n(x.funding_next_apply) !== null ? Number(x.funding_next_apply) * 1e3 : null;
		bid = n(t?.highest_bid);
		ask = n(t?.lowest_ask);
		change = n(t?.change_percentage);
	}
	if (v === "bybit") {
		price = n(q.markPrice);
		volume = n(t?.turnover24h);
		oi = n(t?.singleOpenInterestValue);
		funding = n(t?.fundingRate);
		interval = n(x.fundingInterval) !== null ? Number(x.fundingInterval) / 60 : null;
		nextFunding = n(t?.nextFundingTime);
		bid = n(t?.bid1Price);
		ask = n(t?.ask1Price);
		change = n(t?.price24hPcnt) !== null ? Number(t.price24hPcnt) * 100 : null;
	}
	if (v === "kucoin") {
		price = n(x.markPrice);
		volume = n(x.turnoverOf24h);
		funding = n(x.fundingFeeRate);
		interval = n(x.currentFundingRateGranularity ?? x.fundingRateGranularity) !== null ? Number(x.currentFundingRateGranularity ?? x.fundingRateGranularity) / 36e5 : null;
		nextFunding = n(x.nextFundingRateDateTime);
		change = n(x.priceChgPct) !== null ? Number(x.priceChgPct) * 100 : null;
	}
	if (v === "hyperliquid_xyz") {
		price = n(q.markPx);
		volume = n(q.dayNtlVlm);
		oi = oiNotional(q.openInterest, price);
		funding = n(q.funding);
		interval = 1;
		change = price !== null && Number(q.prevDayPx) > 0 ? (price / Number(q.prevDayPx) - 1) * 100 : null;
	}
	if (v === "lighter") {
		price = n(x.mark_price);
		volume = n(x.daily_quote_token_volume);
		oi = oiNotional(x.open_interest, price);
		change = n(x.daily_price_change);
		if (t?.exchange === "lighter") {
			funding = n(t.rate);
			interval = 8;
		}
	}
	if (v === "bitget") {
		price = n(q.markPrice);
		volume = n(t?.usdtVolume);
		oi = oiNotional(t?.holdingAmount, price, .5);
		funding = n(t?.fundingRate);
		interval = n(x.fundInterval);
		nextFunding = n(t?.nextFundingTime);
		bid = n(t?.bidPr);
		ask = n(t?.askPr);
		change = n(t?.change24h) !== null ? Number(t.change24h) * 100 : null;
	}
	if (v === "mexc") {
		price = n(q.fairPrice);
		volume = n(t?.amount24);
		oi = oiNotional(t?.holdVol, price, x.contractSize ?? null);
		funding = n(t?.fundingRate);
		bid = n(t?.bid1);
		ask = n(t?.ask1);
		change = n(t?.riseFallRate) !== null ? Number(t.riseFallRate) * 100 : null;
	}
	if (["binance", "aster"].includes(v)) {
		price = n(q.markPrice);
		volume = n(q.quoteVolume);
		funding = n(q.lastFundingRate);
		interval = n(q.fundingIntervalHours);
		nextFunding = n(q.nextFundingTime);
		change = n(q.priceChangePercent);
	}
	if (v === "okx") {
		price = n(t?.last);
		bid = n(t?.bidPx);
		ask = n(t?.askPx);
	}
	const oiDefinitions = {
		gate: ["https://api.gateio.ws/api/v4/futures/usdt/contracts", "单边张数 × 合约乘数 × 标记价"],
		bybit: ["https://api.bybit.com/v5/market/tickers?category=linear", "官方 singleOpenInterestValue，单边名义额"],
		hyperliquid_xyz: ["https://api.hyperliquid.xyz/info", "单边基础数量 × 标记价"],
		lighter: ["https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails", "REST 单边基础数量 × 标记价；不采用前端双边显示值"],
		bitget: ["https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES", "双边 holdingAmount × 标记价 ÷ 2"],
		mexc: ["https://contract.mexc.com/api/v1/contract/ticker", "单边持仓张数 × 合约面值 × 合理价；按 MEXC 官方 OI 定义"]
	};
	const has = price !== null || funding !== null || volume !== null || oi !== null;
	return {
		price,
		currency: "USD / USDT",
		volume,
		oi,
		oiAt: oi !== null ? at : null,
		oiSource: oi !== null ? oiDefinitions[v]?.[0] ?? null : null,
		oiBasis: oi !== null ? oiDefinitions[v]?.[1] ?? null : null,
		oiError: null,
		funding,
		interval,
		nextFunding,
		bid: bid && bid > 0 ? bid : null,
		ask: ask && ask > 0 ? ask : null,
		change,
		quoteAt: has ? at : null
	};
}
var aliases = {
	GIGADEVICE: "GIGADEV",
	HUAHONG: "HHGRACE",
	HK0700: "TENCENT",
	HK1810: "XIAOMI",
	HK0625: "SHEIN",
	HK0992: "LENOVO",
	MOONSHOT: "KIMI",
	NTES: "NETEASE",
	FUTUON: "FUTU"
};
function companyKey(symbol) {
	let s = symbol.toUpperCase().split(":").pop().replace(/[-_]/g, "").replace(/USDTSWAP$|USDTM?$/, "").replace(/STOCK$/, "").replace(/HKD$/, "");
	return aliases[s] || s;
}
function discover(old, entries, universe) {
	const known = new Set(old.rows.map((r) => r.symbol));
	const identities = new Map(universe.map((r) => [r.company_key, r]));
	return entries.flatMap((x) => {
		const symbol = symbolOf(old.venue, x), key = companyKey(symbol), ref = identities.get(key);
		if (known.has(symbol) || !ref) return [];
		const v = old.venue;
		if (!(v === "gate" ? x.contract_type === "stocks" : v === "binance" ? [
			"CN_EQUITY",
			"HK_EQUITY",
			"US_EQUITY"
		].includes(x.underlyingType) : v === "bybit" ? x.symbolType === "stock" : v === "bitget" ? x.isRwa === "YES" : v === "mexc" ? x.conceptPlate?.some((p) => p.includes("Stock")) : v === "kucoin" ? x.assetClass === "STOCK" : v === "okx" ? x.instCategory === "3" : false)) return [];
		return [{
			...ref,
			venue: v,
			venue_name: old.name,
			symbol,
			source_url: endpoints[v],
			anchor: "新增匹配合约；上市线尚待人工核验",
			caution: "自动发现于已知公司池；上市线与具体产品类型需复核",
			status: "discovered",
			directory_open: false,
			reason: "新增待刷新",
			price: null,
			volume: null,
			oi: null,
			funding: null,
			interval: null,
			quoteAt: null
		}];
	});
}
function applyDirectory(old, d, quotes, at, quoteError) {
	const entries = directory(old.venue, d);
	const map = new Map(entries.map((x) => [symbolOf(old.venue, x), x]));
	const rows = old.rows.map((r) => {
		const x = map.get(r.symbol);
		if (!x) return {
			...r,
			status: "missing",
			directory_open: false,
			reason: "目录未找到",
			fetched_at: at
		};
		const m = metrics(old.venue, x, quotes?.get(r.symbol), at);
		const intrinsic = [
			"gate",
			"kucoin",
			"hyperliquid_xyz",
			"lighter"
		].includes(old.venue);
		const metricsPatch = quoteError && !intrinsic ? {} : m;
		const out = {
			...r,
			...normalizeStatus(old.venue, x, r),
			...metricsPatch,
			fetched_at: at
		};
		if (old.venue === "mexc" && (quoteError || m.oi === null)) {
			out.oi = r.oi;
			out.oiAt = r.oiAt === void 0 ? r.quoteAt : r.oiAt;
			out.oiSource = r.oiSource;
			out.oiBasis = r.oiBasis;
			out.oiError = quoteError || "本轮持仓数量、面值或合理价缺失";
		}
		if (r.symbol.includes("HKD")) out.currency = "HKD 数值 / USDT quanto";
		return out;
	});
	return {
		...old,
		rows,
		observedAt: at,
		attemptedAt: at,
		error: null,
		quoteError
	};
}
function changes(before, after, at) {
	if (after.error) return [];
	const map = new Map(before.rows.map((r) => [r.symbol, r]));
	return after.rows.flatMap((r) => {
		const old = map.get(r.symbol);
		const a = old ? stateLabel(old) : "未收录";
		const b = stateLabel(r);
		return a !== b ? [{
			id: `${at}:${r.venue}:${r.symbol}`,
			at,
			venue: r.venue_name,
			company: r.company_name,
			symbol: r.symbol,
			before: a,
			after: b
		}] : [];
	});
}
//#endregion
//#region lib/open-interest.ts
function observedTime(value, fallback) {
	const n = number(value);
	if (n === null || n <= 0) return fallback;
	const date = new Date(n);
	return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}
function retained(row, old, error) {
	return {
		...row,
		oi: old?.oi ?? null,
		oiAt: old?.oi != null ? old.oiAt === void 0 ? old.quoteAt : old.oiAt : null,
		oiSource: old?.oiSource ?? null,
		oiBasis: old?.oiBasis ?? null,
		oiError: error
	};
}
async function refreshOpenInterest(provider, previous, get) {
	const v = provider.venue;
	if (![
		"binance",
		"okx",
		"htx"
	].includes(v)) return provider;
	const readings = /* @__PURE__ */ new Map();
	const errors = /* @__PURE__ */ new Map();
	let failure = null;
	try {
		if (v === "okx" || v === "htx") {
			const source = v === "okx" ? "https://www.okx.com/api/v5/public/open-interest?instType=SWAP" : "https://api.hbdm.com/linear-swap-api/v1/swap_open_interest";
			const data = await get(source);
			if ((v === "okx" ? data.code !== "0" : data.status !== "ok") || !Array.isArray(data.data) || !data.data.length) throw Error("持仓响应异常");
			const at = (/* @__PURE__ */ new Date()).toISOString();
			for (const item of data.data) {
				const value = number(v === "okx" ? item.oiUsd : item.value);
				if (value === null || value < 0) continue;
				readings.set(v === "okx" ? item.instId : item.contract_code, {
					value,
					at: observedTime(v === "okx" ? item.ts : data.ts, at),
					source,
					basis: v === "okx" ? "官方 oiUsd，单边美元名义额" : "官方 value，单边 USDT 名义额"
				});
			}
		} else {
			const rows = provider.rows.filter((r) => r.status !== "missing");
			let cursor = 0;
			await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
				while (cursor < rows.length) {
					const row = rows[cursor++];
					const source = `https://fapi.binance.com/fapi/v1/openInterest?symbol=${encodeURIComponent(row.symbol)}`;
					try {
						const data = await get(source);
						if (data.symbol !== row.symbol) throw Error("持仓合约不匹配");
						if (provider.quoteError || row.quoteAt !== provider.observedAt) throw Error("本轮标记价缺失，未折算持仓");
						const value = oiNotional(data.openInterest, row.price);
						if (value === null) throw Error("持仓数量或标记价缺失");
						readings.set(row.symbol, {
							value,
							at: observedTime(data.time, (/* @__PURE__ */ new Date()).toISOString()),
							source,
							basis: "单边 openInterest 基础数量 × 本轮标记价"
						});
					} catch (e) {
						errors.set(row.symbol, e instanceof Error ? e.message : "持仓暂不可用");
					}
				}
			}));
		}
	} catch (e) {
		failure = e instanceof Error ? e.message : "持仓暂不可用";
	}
	const old = new Map(previous.rows.map((r) => [r.symbol, r]));
	return {
		...provider,
		rows: provider.rows.map((row) => {
			const reading = readings.get(row.symbol);
			return reading ? {
				...row,
				oi: reading.value,
				oiAt: reading.at,
				oiSource: reading.source,
				oiBasis: reading.basis,
				oiError: null
			} : retained(row, old.get(row.symbol), failure || errors.get(row.symbol) || "本轮未提供该合约持仓");
		})
	};
}
//#endregion
//#region lib/providers.ts
async function get(url, body) {
	const response = await fetch(url, {
		...body ? {
			method: "POST",
			body: JSON.stringify(body)
		} : {},
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json"
		},
		signal: AbortSignal.timeout(9e3)
	});
	if (!response.ok) throw Error(`HTTP ${response.status}`);
	return response.json();
}
async function refreshProvider(old, universe = old.rows) {
	const v = old.venue;
	let at = (/* @__PURE__ */ new Date()).toISOString();
	try {
		let d = await get(endpoints[v], v === "hyperliquid_xyz" ? {
			type: "metaAndAssetCtxs",
			dex: "xyz"
		} : void 0);
		if (v === "bybit") {
			const cursors = /* @__PURE__ */ new Set();
			let cursor = d.result?.nextPageCursor;
			while (cursor) {
				if (cursors.has(cursor) || cursors.size >= 10) throw Error("目录分页未完整");
				cursors.add(cursor);
				const next = await get(endpoints[v] + "&cursor=" + encodeURIComponent(cursor));
				directory(v, next);
				d.result.list.push(...next.result.list);
				cursor = next.result.nextPageCursor;
			}
		}
		directory(v, d);
		let quotes = null, quoteError = null;
		try {
			let q;
			if (v === "gate") q = await get("https://api.gateio.ws/api/v4/futures/usdt/tickers");
			if (v === "bybit") {
				const t = await get("https://api.bybit.com/v5/market/tickers?category=linear");
				if (t.retCode !== 0) throw Error("行情格式异常");
				q = t.result.list;
			}
			if (v === "bitget") {
				const t = await get("https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES");
				if (t.code !== "00000") throw Error("行情格式异常");
				q = t.data;
			}
			if (v === "mexc") {
				const t = await get("https://contract.mexc.com/api/v1/contract/ticker");
				if (!t.success) throw Error("行情格式异常");
				q = t.data;
			}
			if (v === "okx") {
				const t = await get("https://www.okx.com/api/v5/market/tickers?instType=SWAP");
				if (t.code !== "0") throw Error("行情格式异常");
				q = t.data;
			}
			if (["binance", "aster"].includes(v)) {
				const root = v === "binance" ? "https://fapi.binance.com" : "https://fapi.asterdex.com";
				const [premium, tickers, info] = await Promise.all([
					get(root + "/fapi/v1/premiumIndex"),
					get(root + "/fapi/v1/ticker/24hr"),
					get(root + "/fapi/v1/fundingInfo")
				]);
				if (!Array.isArray(premium) || !Array.isArray(tickers) || !Array.isArray(info)) throw Error("行情格式异常");
				const ticks = new Map(tickers.map((x) => [x.symbol, x]));
				const intervals = new Map(info.map((x) => [x.symbol, x.fundingIntervalHours]));
				q = premium.map((x) => ({
					...ticks.get(x.symbol),
					...x,
					fundingIntervalHours: intervals.get(x.symbol) ?? null
				}));
			}
			if (v === "hyperliquid_xyz") {
				if (!Array.isArray(d[1]) || d[0].universe.length !== d[1].length) throw Error("行情目录长度不匹配");
				q = d[0].universe.map((x, i) => ({
					...d[1][i],
					symbol: x.name
				}));
			}
			if (v === "lighter") {
				const f = await get("https://mainnet.zklighter.elliot.ai/api/v1/funding-rates");
				if (f.code !== 200 || !Array.isArray(f.funding_rates)) throw Error("资金费格式异常");
				const rates = new Map(f.funding_rates.filter((r) => r.exchange === "lighter").map((r) => [r.market_id, r]));
				q = d.order_book_details.map((x) => ({
					...rates.get(x.market_id),
					symbol: x.symbol
				}));
			}
			if (q !== void 0) {
				if (!Array.isArray(q) || !q.length) throw Error("行情为空");
				quotes = new Map(q.map((x) => [x.symbol ?? x.contract ?? x.instId, x]));
			}
		} catch (e) {
			quoteError = e instanceof Error ? e.message : "行情暂不可用";
		}
		at = (/* @__PURE__ */ new Date()).toISOString();
		const added = discover(old, directory(v, d), universe);
		const result = applyDirectory({
			...old,
			rows: [...old.rows, ...added]
		}, d, quotes, at, quoteError);
		if (v === "hyperliquid_xyz") try {
			const caps = await get(endpoints[v], {
				type: "perpsAtOpenInterestCap",
				dex: "xyz"
			});
			if (!Array.isArray(caps) || caps.some((x) => typeof x !== "string")) throw Error("OI 上限响应异常");
			result.rows = result.rows.map((r) => caps.includes(r.symbol) ? {
				...r,
				directory_open: false,
				reason: "OI 达上限"
			} : r);
		} catch {
			result.quoteError = [result.quoteError, "本轮 OI 上限未确认"].filter(Boolean).join("；");
			result.rows = result.rows.map((r) => r.directory_open ? {
				...r,
				directory_open: false,
				reason: "OI 上限待核"
			} : r);
		}
		if (v === "lighter") result.rows = result.rows.map((r) => ({
			...r,
			fundingBasis: "8h 等效 / 每小时结算"
		}));
		return await refreshOpenInterest(result, old, get);
	} catch (e) {
		return {
			...old,
			attemptedAt: at,
			error: e instanceof Error ? e.message : "来源暂不可用"
		};
	}
}
//#endregion
//#region data/seed.json
var seed_default = /* @__PURE__ */ JSON.parse("[{\"venue\":\"gate\",\"name\":\"Gate\",\"observedAt\":\"2026-09-10T08:53:19.675Z\",\"attemptedAt\":\"2026-09-10T08:53:19.675Z\",\"error\":null,\"quoteError\":null,\"rows\":[{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"ACCELINK_USDT\",\"company_key\":\"ACCELINK\",\"company_name\":\"光迅科技\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":26.76,\"currency\":\"USD / USDT\",\"volume\":9712,\"oi\":4648.212,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":26.71,\"ask\":26.81,\"change\":-1.03,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"AKESO_USDT\",\"company_key\":\"AKESO\",\"company_name\":\"康方生物\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":12.091,\"currency\":\"USD / USDT\",\"volume\":1525,\"oi\":9065.8318,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":12.115,\"ask\":12.139,\"change\":-0.96,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"AMEC_USDT\",\"company_key\":\"AMEC\",\"company_name\":\"中微公司\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":49.92,\"currency\":\"USD / USDT\",\"volume\":613,\"oi\":6195.072000000001,\"funding\":0.0002,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":49.92,\"ask\":50.32,\"change\":0.18,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"ANTA_USDT\",\"company_key\":\"ANTA\",\"company_name\":\"安踏体育\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":9.267,\"currency\":\"USD / USDT\",\"volume\":1150,\"oi\":4450.0134,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":9.267,\"ask\":9.328,\"change\":-2.1,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"BABA_USDT\",\"company_key\":\"BABA\",\"company_name\":\"阿里巴巴\",\"layer\":\"美股中概补充\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":109.2,\"currency\":\"USD / USDT\",\"volume\":622967,\"oi\":750612.4079999999,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":109.21,\"ask\":109.22,\"change\":-2.78,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"BEIGENE_USDT\",\"company_key\":\"BEIGENE\",\"company_name\":\"百济神州\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":37.84,\"currency\":\"USD / USDT\",\"volume\":16231,\"oi\":189.20000000000002,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":37.56,\"ask\":37.91,\"change\":-0.29,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"BIWIN_USDT\",\"company_key\":\"BIWIN\",\"company_name\":\"佰维存储\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":32.64,\"currency\":\"USD / USDT\",\"volume\":448,\"oi\":11061.696000000002,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":32.59,\"ask\":32.69,\"change\":-0.18,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"BLUEFOCUS_USDT\",\"company_key\":\"BLUEFOCUS\",\"company_name\":\"蓝色光标\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":2.007,\"currency\":\"USD / USDT\",\"volume\":1250,\"oi\":5800.2300000000005,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":2.003,\"ask\":2.011,\"change\":-0.59,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"BOE_USDT\",\"company_key\":\"BOE\",\"company_name\":\"京东方 A\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":0.8259,\"currency\":\"USD / USDT\",\"volume\":1675,\"oi\":16767.4218,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":0.83,\"ask\":0.8355,\"change\":-0.12,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"BYD_USDT\",\"company_key\":\"BYD\",\"company_name\":\"比亚迪\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":10.134,\"currency\":\"USD / USDT\",\"volume\":42462,\"oi\":28154.278800000004,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":10.13,\"ask\":10.136,\"change\":-3.3,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"CAMBRICON_USDT\",\"company_key\":\"CAMBRICON\",\"company_name\":\"寒武纪\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":157.07,\"currency\":\"USD / USDT\",\"volume\":3076,\"oi\":14780.287,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":156.38,\"ask\":157.99,\"change\":-0.69,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"CATL_USDT\",\"company_key\":\"CATL\",\"company_name\":\"宁德时代\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":70.88,\"currency\":\"USD / USDT\",\"volume\":12898,\"oi\":31300.608,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":69.71,\"ask\":70.72,\"change\":-0.29,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"CCTC_USDT\",\"company_key\":\"CCTC\",\"company_name\":\"三环集团\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":17.56,\"currency\":\"USD / USDT\",\"volume\":1382,\"oi\":4145.916,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":17.539,\"ask\":17.765,\"change\":-0.33,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"CIG_USDT\",\"company_key\":\"CIG\",\"company_name\":\"剑桥科技\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":34.01,\"currency\":\"USD / USDT\",\"volume\":52178,\"oi\":19093.213999999996,\"funding\":-0.0002,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":33.55,\"ask\":34,\"change\":4.78,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"CITIC_USDT\",\"company_key\":\"CITIC\",\"company_name\":\"中信股份\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":1.7496,\"currency\":\"USD / USDT\",\"volume\":1195,\"oi\":5269.7952000000005,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":1.7359,\"ask\":1.7618,\"change\":-0.38,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"CJS_USDT\",\"company_key\":\"CJS\",\"company_name\":\"中国巨石\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":6.484,\"currency\":\"USD / USDT\",\"volume\":2139,\"oi\":7456.6,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":6.412,\"ask\":6.498,\"change\":3.66,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"CMOC_USDT\",\"company_key\":\"CMOC\",\"company_name\":\"洛阳钼业\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":2.836,\"currency\":\"USD / USDT\",\"volume\":2093,\"oi\":12915.144,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":2.826,\"ask\":2.842,\"change\":-0.35,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"CXMT_USDT\",\"company_key\":\"CXMT\",\"company_name\":\"长鑫存储\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":8.394,\"currency\":\"USD / USDT\",\"volume\":15315660,\"oi\":2940065.6520000002,\"funding\":-0.000193,\"interval\":1,\"nextFunding\":1789030800000,\"bid\":8.392,\"ask\":8.394,\"change\":0.47,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"DEEPTECH_USDT\",\"company_key\":\"DEEPTECH\",\"company_name\":\"滴普科技\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":4.17,\"currency\":\"USD / USDT\",\"volume\":1679,\"oi\":17071.98,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":4.163,\"ask\":4.176,\"change\":-6.21,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"DEMINGLI_USDT\",\"company_key\":\"DEMINGLI\",\"company_name\":\"德明利\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":62.39,\"currency\":\"USD / USDT\",\"volume\":3460,\"oi\":7237.24,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":62.27,\"ask\":62.5,\"change\":2.29,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"DSBJ_USDT\",\"company_key\":\"DSBJ\",\"company_name\":\"东山精密\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":28.67,\"currency\":\"USD / USDT\",\"volume\":10348,\"oi\":6367.607000000001,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":28.45,\"ask\":28.67,\"change\":-0.73,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"EOPTOLINK_USDT\",\"company_key\":\"EOPTOLINK\",\"company_name\":\"新易盛\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":61.91,\"currency\":\"USD / USDT\",\"volume\":5192,\"oi\":27983.32,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":61.85,\"ask\":62.01,\"change\":1.33,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"FENGHUA_USDT\",\"company_key\":\"FENGHUA\",\"company_name\":\"风华高科\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":7.636,\"currency\":\"USD / USDT\",\"volume\":3008,\"oi\":4627.416,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":7.577,\"ask\":7.746,\"change\":1.43,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"FII_USDT\",\"company_key\":\"FII\",\"company_name\":\"工业富联\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":9.534,\"currency\":\"USD / USDT\",\"volume\":6289,\"oi\":14796.768000000002,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":9.526,\"ask\":9.541,\"change\":-1.04,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"FUTUON_USDT\",\"company_key\":\"FUTU\",\"company_name\":\"富途控股\",\"layer\":\"美股中概补充\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"FUTUON为代币化股票相关合约；与直连ADR产品分别识别\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":119.51,\"currency\":\"USD / USDT\",\"volume\":21171,\"oi\":891601.9648000001,\"funding\":0.0002,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":126.11,\"ask\":127.93,\"change\":-0.55,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"GEELY_USDT\",\"company_key\":\"GEELY\",\"company_name\":\"吉利汽车\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":2.081,\"currency\":\"USD / USDT\",\"volume\":1692,\"oi\":5190.014,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":2.081,\"ask\":2.091,\"change\":-1.79,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"GIGADEV_USDT\",\"company_key\":\"GIGADEV\",\"company_name\":\"兆易创新\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":60.91,\"currency\":\"USD / USDT\",\"volume\":15588,\"oi\":40541.695999999996,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":60.88,\"ask\":61.06,\"change\":-1.39,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"HENGRUI_USDT\",\"company_key\":\"HENGRUI\",\"company_name\":\"恒瑞医药\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":6.447,\"currency\":\"USD / USDT\",\"volume\":30939,\"oi\":7955.598,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":6.406,\"ask\":6.495,\"change\":-2.98,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"HHGRACE_USDT\",\"company_key\":\"HHGRACE\",\"company_name\":\"华虹半导体\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":14.264,\"currency\":\"USD / USDT\",\"volume\":2636,\"oi\":20558.7032,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":14,\"ask\":14.241,\"change\":-0.83,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"HTGD_USDT\",\"company_key\":\"HTGD\",\"company_name\":\"亨通光电\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":9.573,\"currency\":\"USD / USDT\",\"volume\":20349,\"oi\":17260.119000000002,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":9.521,\"ask\":9.63,\"change\":-3.26,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"HUAGONGTECH_USDT\",\"company_key\":\"HUAGONGTECH\",\"company_name\":\"华工科技\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":15.784,\"currency\":\"USD / USDT\",\"volume\":8431,\"oi\":7850.9616000000005,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":15.605,\"ask\":15.813,\"change\":-2.49,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"HYGON_USDT\",\"company_key\":\"HYGON\",\"company_name\":\"海光信息\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":34.61,\"currency\":\"USD / USDT\",\"volume\":1470,\"oi\":1737.422,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":34.56,\"ask\":34.72,\"change\":-1.62,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"IEIT_USDT\",\"company_key\":\"IEIT\",\"company_name\":\"浪潮信息\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":10.565,\"currency\":\"USD / USDT\",\"volume\":7569,\"oi\":14210.9815,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":10.56,\"ask\":10.731,\"change\":-3.24,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"JD_USDT\",\"company_key\":\"JD\",\"company_name\":\"京东\",\"layer\":\"美股中概补充\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":26.977,\"currency\":\"USD / USDT\",\"volume\":8277,\"oi\":5907.963,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":26.9,\"ask\":27.059,\"change\":-1.24,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"JUNZHENG_USDT\",\"company_key\":\"JUNZHENG\",\"company_name\":\"北京君正\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":19.759,\"currency\":\"USD / USDT\",\"volume\":0,\"oi\":2297.9717,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":19.737,\"ask\":19.783,\"change\":0,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"KBHLD_USDT\",\"company_key\":\"KBHLD\",\"company_name\":\"建滔集团\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"Gate公告100355：0148.HK\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":6.739,\"currency\":\"USD / USDT\",\"volume\":6246,\"oi\":36517.2932,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":6.5,\"ask\":6.739,\"change\":1.6,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"KBLAM_USDT\",\"company_key\":\"KBLAM\",\"company_name\":\"建滔积层板\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"Gate公告100355：1888.HK\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":6.159,\"currency\":\"USD / USDT\",\"volume\":5464,\"oi\":20595.696,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":6.085,\"ask\":6.23,\"change\":1.37,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"KIMI_USDT\",\"company_key\":\"KIMI\",\"company_name\":\"月之暗面 / Kimi\",\"layer\":\"预上市补充\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"预上市价格预期；不等同于上市后股价\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":8.23,\"currency\":\"USD / USDT\",\"volume\":2028,\"oi\":356227.32,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":8.175,\"ask\":8.225,\"change\":0.31,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"KUAISHOU_USDT\",\"company_key\":\"KUAISHOU\",\"company_name\":\"快手科技\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":4.043,\"currency\":\"USD / USDT\",\"volume\":13542,\"oi\":176485.036,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":4.033,\"ask\":4.05,\"change\":-2.1,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"LAOPU_USDT\",\"company_key\":\"LAOPU\",\"company_name\":\"老铺黄金\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":49.36,\"currency\":\"USD / USDT\",\"volume\":1522,\"oi\":18924.624,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":48.54,\"ask\":50.61,\"change\":1,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"LENOVO_USDT\",\"company_key\":\"LENOVO\",\"company_name\":\"联想集团\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":4.1134,\"currency\":\"USD / USDT\",\"volume\":2810,\"oi\":24474.730000000003,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":4.0904,\"ask\":4.1317,\"change\":-0.55,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"LETTALL_USDT\",\"company_key\":\"LETTALL\",\"company_name\":\"利通电子\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":15.887,\"currency\":\"USD / USDT\",\"volume\":11491,\"oi\":15157.7867,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":15.881,\"ask\":16.149,\"change\":-3.25,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"LONGSYS_USDT\",\"company_key\":\"LONGSYS\",\"company_name\":\"江波龙\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":51.76,\"currency\":\"USD / USDT\",\"volume\":17221,\"oi\":13576.648,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":51.45,\"ask\":51.82,\"change\":-0.5,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"LUXSHARE_USDT\",\"company_key\":\"LUXSHARE\",\"company_name\":\"立讯精密\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":8.204,\"currency\":\"USD / USDT\",\"volume\":376,\"oi\":10296.02,\"funding\":0.0002,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":8.198,\"ask\":8.735,\"change\":-2.58,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"MEITUAN_USDT\",\"company_key\":\"MEITUAN\",\"company_name\":\"美团\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":9.631,\"currency\":\"USD / USDT\",\"volume\":15761,\"oi\":89637.6432,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":9.606,\"ask\":9.652,\"change\":-3.27,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"MIDEA_USDT\",\"company_key\":\"MIDEA\",\"company_name\":\"美的集团\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":12.858,\"currency\":\"USD / USDT\",\"volume\":3873,\"oi\":4192.9938,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":12.834,\"ask\":12.875,\"change\":-1.33,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"MINIMAXHKD_USDT\",\"company_key\":\"MINIMAX\",\"company_name\":\"MiniMax（稀宇科技）\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":291.9,\"currency\":\"HKD 数值 / USDT quanto\",\"volume\":9773,\"oi\":32114.837999999996,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":290.8,\"ask\":294.11,\"change\":-9.28,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"MINIMAX_USDT\",\"company_key\":\"MINIMAX\",\"company_name\":\"MiniMax（稀宇科技）\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":37.3,\"currency\":\"USD / USDT\",\"volume\":5442655,\"oi\":628692.992,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":37.31,\"ask\":37.33,\"change\":-9.88,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"MONTAGE_USDT\",\"company_key\":\"MONTAGE\",\"company_name\":\"澜起科技\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":29.16,\"currency\":\"USD / USDT\",\"volume\":1143,\"oi\":20184.552,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":29.16,\"ask\":29.19,\"change\":0.1,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"MOUTAI_USDT\",\"company_key\":\"MOUTAI\",\"company_name\":\"贵州茅台\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":193.62,\"currency\":\"USD / USDT\",\"volume\":3399,\"oi\":1688.3664,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":193.78,\"ask\":193.81,\"change\":0.28,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"NAURA_USDT\",\"company_key\":\"NAURA\",\"company_name\":\"北方华创\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":94.67,\"currency\":\"USD / USDT\",\"volume\":3228,\"oi\":8482.432,\"funding\":-0.0002,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":94.13,\"ask\":95,\"change\":-1.18,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"PDD_USDT\",\"company_key\":\"PDD\",\"company_name\":\"拼多多\",\"layer\":\"美股中概补充\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":78.95,\"currency\":\"USD / USDT\",\"volume\":19357,\"oi\":170058.30000000002,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":78.87,\"ask\":79.11,\"change\":-1.28,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"PERIC_USDT\",\"company_key\":\"PERIC\",\"company_name\":\"中船特气\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":33.69,\"currency\":\"USD / USDT\",\"volume\":1446,\"oi\":3557.664,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":33.69,\"ask\":34.1,\"change\":-1.46,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"POPMART_USDT\",\"company_key\":\"POPMART\",\"company_name\":\"泡泡玛特\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":19.438,\"currency\":\"USD / USDT\",\"volume\":21313,\"oi\":143856.7504,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":19.419,\"ask\":19.458,\"change\":-2.4,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"PUYA_USDT\",\"company_key\":\"PUYA\",\"company_name\":\"普冉股份\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":59.21,\"currency\":\"USD / USDT\",\"volume\":351,\"oi\":1912.4830000000002,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":58.83,\"ask\":59.64,\"change\":-0.03,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"SBP_USDT\",\"company_key\":\"SBP\",\"company_name\":\"中国生物制药\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":0.7057,\"currency\":\"USD / USDT\",\"volume\":1795,\"oi\":8764.794,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":0.7046,\"ask\":0.7069,\"change\":-0.98,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"SHEIN_USDT\",\"company_key\":\"SHEIN\",\"company_name\":\"SHEIN（希音）\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":5.227,\"currency\":\"USD / USDT\",\"volume\":4799,\"oi\":18378.132,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":5.217,\"ask\":5.238,\"change\":0.97,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"SHENHUA_USDT\",\"company_key\":\"SHENHUA\",\"company_name\":\"中国神华\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":7.042,\"currency\":\"USD / USDT\",\"volume\":35,\"oi\":2535.12,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":6.945,\"ask\":7.045,\"change\":-0.04,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"SHTECH_USDT\",\"company_key\":\"SHTECH\",\"company_name\":\"胜宏科技\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":34.36,\"currency\":\"USD / USDT\",\"volume\":5907,\"oi\":25014.079999999998,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":34.36,\"ask\":37.1,\"change\":-1.18,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"SINOCERA_USDT\",\"company_key\":\"SINOCERA\",\"company_name\":\"国瓷材料\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":9.005,\"currency\":\"USD / USDT\",\"volume\":13356,\"oi\":6093.683500000001,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":8.988,\"ask\":9.144,\"change\":-1.82,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"SMIC_USDT\",\"company_key\":\"SMIC\",\"company_name\":\"中芯国际\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":8.104,\"currency\":\"USD / USDT\",\"volume\":7681,\"oi\":54961.327999999994,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":8.141,\"ask\":8.303,\"change\":-3.42,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"SUNAC_USDT\",\"company_key\":\"SUNAC\",\"company_name\":\"融创中国\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":0.07309,\"currency\":\"USD / USDT\",\"volume\":2587,\"oi\":28771.1476,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":0.07305,\"ask\":0.07314,\"change\":-1.69,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"SUNGROW_USDT\",\"company_key\":\"SUNGROW\",\"company_name\":\"阳光电源\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":12.903,\"currency\":\"USD / USDT\",\"volume\":6619,\"oi\":24848.597400000002,\"funding\":0.0002,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":12.931,\"ask\":12.934,\"change\":-0.55,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"SYTECH_USDT\",\"company_key\":\"SYTECH\",\"company_name\":\"生益科技\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":21.914,\"currency\":\"USD / USDT\",\"volume\":2595,\"oi\":17461.075200000003,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":21.897,\"ask\":21.95,\"change\":-0.81,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"TAIJI_USDT\",\"company_key\":\"TAIJI\",\"company_name\":\"太极实业\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":2.997,\"currency\":\"USD / USDT\",\"volume\":22177,\"oi\":17571.411,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":2.98,\"ask\":3.016,\"change\":12.43,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"TENCENTHKD_USDT\",\"company_key\":\"TENCENT\",\"company_name\":\"腾讯控股\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":426.05,\"currency\":\"HKD 数值 / USDT quanto\",\"volume\":14251,\"oi\":129996.376,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":425.1,\"ask\":428.47,\"change\":-1.67,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"TENCENT_USDT\",\"company_key\":\"TENCENT\",\"company_name\":\"腾讯控股\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":54.62,\"currency\":\"USD / USDT\",\"volume\":470448,\"oi\":768350.464,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":54.62,\"ask\":54.67,\"change\":-1.83,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"TFC_USDT\",\"company_key\":\"TFC\",\"company_name\":\"天孚通信\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":40.1,\"currency\":\"USD / USDT\",\"volume\":9045,\"oi\":13654.050000000001,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":40,\"ask\":40.17,\"change\":4.18,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"TFME_USDT\",\"company_key\":\"TFME\",\"company_name\":\"通富微电\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":8.704,\"currency\":\"USD / USDT\",\"volume\":826,\"oi\":8747.52,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":8.601,\"ask\":8.704,\"change\":-1.09,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"TONGGUAN_USDT\",\"company_key\":\"TONGGUAN\",\"company_name\":\"铜冠铜箔\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":16.167,\"currency\":\"USD / USDT\",\"volume\":22,\"oi\":1910.9394000000002,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":15.93,\"ask\":16.18,\"change\":0,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"TUNGSTEN_USDT\",\"company_key\":\"TUNGSTEN\",\"company_name\":\"中钨高新\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":8.865,\"currency\":\"USD / USDT\",\"volume\":1660,\"oi\":10070.64,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":8.717,\"ask\":8.881,\"change\":-1.21,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"UNIS_USDT\",\"company_key\":\"UNIS\",\"company_name\":\"紫光股份\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":4.938,\"currency\":\"USD / USDT\",\"volume\":579,\"oi\":4898.496,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":4.825,\"ask\":4.958,\"change\":-1.4,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"UNITREE_USDT\",\"company_key\":\"UNITREE\",\"company_name\":\"宇树科技\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":74.096,\"currency\":\"USD / USDT\",\"volume\":3562899,\"oi\":2160387.4336,\"funding\":-0.000187,\"interval\":4,\"nextFunding\":1789041600000,\"bid\":74.062,\"ask\":74.063,\"change\":-3.63,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"WANGSU_USDT\",\"company_key\":\"WANGSU\",\"company_name\":\"网宿科技\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":2.248,\"currency\":\"USD / USDT\",\"volume\":0,\"oi\":2146.84,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":2.211,\"ask\":2.258,\"change\":0,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"WUXIAPPTEC_USDT\",\"company_key\":\"WUXIAPPTEC\",\"company_name\":\"药明康德\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":22.817,\"currency\":\"USD / USDT\",\"volume\":9845,\"oi\":9923.1133,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":22.499,\"ask\":22.502,\"change\":-2.66,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"XIAOMIHKD_USDT\",\"company_key\":\"XIAOMI\",\"company_name\":\"小米集团\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":25.97,\"currency\":\"HKD 数值 / USDT quanto\",\"volume\":375040,\"oi\":331906.988,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":25.93,\"ask\":26.02,\"change\":-1.63,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"XIAOMI_USDT\",\"company_key\":\"XIAOMI\",\"company_name\":\"小米集团\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":3.317,\"currency\":\"USD / USDT\",\"volume\":722652,\"oi\":484865.792,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":3.319,\"ask\":3.321,\"change\":-1.92,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"XIECHUANG_USDT\",\"company_key\":\"XIECHUANG\",\"company_name\":\"协创数据\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":39.31,\"currency\":\"USD / USDT\",\"volume\":169,\"oi\":290.894,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":39.47,\"ask\":39.5,\"change\":1.37,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"XUNCE_USDT\",\"company_key\":\"XUNCE\",\"company_name\":\"深圳迅策科技\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":13.59,\"currency\":\"USD / USDT\",\"volume\":2322,\"oi\":26530.398,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":13.6,\"ask\":13.61,\"change\":-5.29,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"YANGTZE_USDT\",\"company_key\":\"YANGTZE\",\"company_name\":\"长江电力\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":4.191,\"currency\":\"USD / USDT\",\"volume\":0,\"oi\":7443.215999999999,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":4.185,\"ask\":4.197,\"change\":0,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"YJTECH_USDT\",\"company_key\":\"YJTECH\",\"company_name\":\"源杰科技\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":253.8,\"currency\":\"USD / USDT\",\"volume\":14518,\"oi\":78916.572,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":251,\"ask\":253.1,\"change\":-0.38,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"YOFC_USDT\",\"company_key\":\"YOFC\",\"company_name\":\"长飞光纤光缆\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":22.398,\"currency\":\"USD / USDT\",\"volume\":24330,\"oi\":48800.76240000001,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":22.007,\"ask\":22.33,\"change\":-1.56,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"YONGDING_USDT\",\"company_key\":\"YONGDING\",\"company_name\":\"永鼎股份\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":6.024,\"currency\":\"USD / USDT\",\"volume\":604,\"oi\":3620.424,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":5.926,\"ask\":6.037,\"change\":-1.29,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"ZHIPUHKD_USDT\",\"company_key\":\"ZHIPU\",\"company_name\":\"智谱\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":818.3,\"currency\":\"HKD 数值 / USDT quanto\",\"volume\":20722,\"oi\":216964.06199999998,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":815.2,\"ask\":818.4,\"change\":-10.87,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"ZHIPU_USDT\",\"company_key\":\"ZHIPU\",\"company_name\":\"智谱\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":104.76,\"currency\":\"USD / USDT\",\"volume\":5841455,\"oi\":2076024.7296,\"funding\":0.00117,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":104.77,\"ask\":104.78,\"change\":-10.83,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"ZHONGJI_USDT\",\"company_key\":\"ZHONGJI\",\"company_name\":\"中际旭创\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":143.21,\"currency\":\"USD / USDT\",\"volume\":287087,\"oi\":87946.6931,\"funding\":0,\"interval\":4,\"nextFunding\":1789041600000,\"bid\":143.16,\"ask\":143.29,\"change\":-4.58,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"ZIJINMINING_USDT\",\"company_key\":\"ZIJINMINING\",\"company_name\":\"紫金矿业\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":4.766,\"currency\":\"USD / USDT\",\"volume\":4815,\"oi\":12839.604,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":4.766,\"ask\":4.831,\"change\":0.13,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null},{\"venue\":\"gate\",\"venue_name\":\"Gate\",\"symbol\":\"ZTT_USDT\",\"company_key\":\"ZTT\",\"company_name\":\"中天科技\",\"layer\":\"已上市公司\",\"status\":\"trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.gateio.ws/api/v4/futures/usdt/contracts\",\"fetched_at\":\"2026-09-10T08:53:19.675Z\",\"price\":4.999,\"currency\":\"USD / USDT\",\"volume\":946,\"oi\":6348.73,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":4.996,\"ask\":5.052,\"change\":-1.73,\"quoteAt\":\"2026-09-10T08:53:19.675Z\",\"quoteSource\":null}]},{\"venue\":\"binance\",\"name\":\"Binance\",\"observedAt\":\"2026-09-10T08:53:21.301Z\",\"attemptedAt\":\"2026-09-10T08:53:21.301Z\",\"error\":null,\"quoteError\":null,\"rows\":[{\"venue\":\"binance\",\"venue_name\":\"Binance\",\"symbol\":\"BABAUSDT\",\"company_key\":\"BABA\",\"company_name\":\"阿里巴巴\",\"layer\":\"美股中概补充\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"EQUITY；按合约名称映射公司\",\"source_url\":\"https://fapi.binance.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:21.301Z\",\"price\":109.17,\"currency\":\"USD / USDT\",\"volume\":16080724.2122,\"oi\":null,\"funding\":5.354e-05,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":-2.77,\"quoteAt\":\"2026-09-10T08:53:21.301Z\",\"quoteSource\":null},{\"venue\":\"binance\",\"venue_name\":\"Binance\",\"symbol\":\"MINIMAXUSDT\",\"company_key\":\"MINIMAX\",\"company_name\":\"MiniMax（稀宇科技）\",\"layer\":\"已上市公司\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"HK_EQUITY；按合约名称映射公司\",\"source_url\":\"https://fapi.binance.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:21.301Z\",\"price\":37.3,\"currency\":\"USD / USDT\",\"volume\":35494678.525,\"oi\":null,\"funding\":1.058e-05,\"interval\":4,\"nextFunding\":1789041600000,\"bid\":null,\"ask\":null,\"change\":-9.838,\"quoteAt\":\"2026-09-10T08:53:21.301Z\",\"quoteSource\":null},{\"venue\":\"binance\",\"venue_name\":\"Binance\",\"symbol\":\"ZHIPUUSDT\",\"company_key\":\"ZHIPU\",\"company_name\":\"智谱\",\"layer\":\"已上市公司\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"HK_EQUITY；按合约名称映射公司\",\"source_url\":\"https://fapi.binance.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:21.301Z\",\"price\":104.56036639,\"currency\":\"USD / USDT\",\"volume\":34598481.3108,\"oi\":null,\"funding\":0.0006415,\"interval\":4,\"nextFunding\":1789041600000,\"bid\":null,\"ask\":null,\"change\":-10.86,\"quoteAt\":\"2026-09-10T08:53:21.301Z\",\"quoteSource\":null},{\"venue\":\"binance\",\"venue_name\":\"Binance\",\"symbol\":\"HK0700USDT\",\"company_key\":\"TENCENT\",\"company_name\":\"腾讯控股\",\"layer\":\"已上市公司\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"HK_EQUITY；按合约名称映射公司\",\"source_url\":\"https://fapi.binance.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:21.301Z\",\"price\":426.90473203,\"currency\":\"USD / USDT\",\"volume\":1419085.6661,\"oi\":null,\"funding\":0,\"interval\":4,\"nextFunding\":1789041600000,\"bid\":null,\"ask\":null,\"change\":-2.016,\"quoteAt\":\"2026-09-10T08:53:21.301Z\",\"quoteSource\":null},{\"venue\":\"binance\",\"venue_name\":\"Binance\",\"symbol\":\"HK1810USDT\",\"company_key\":\"XIAOMI\",\"company_name\":\"小米集团\",\"layer\":\"已上市公司\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"HK_EQUITY；按合约名称映射公司\",\"source_url\":\"https://fapi.binance.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:21.301Z\",\"price\":25.96,\"currency\":\"USD / USDT\",\"volume\":9561310.4961,\"oi\":null,\"funding\":0.00022783,\"interval\":4,\"nextFunding\":1789041600000,\"bid\":null,\"ask\":null,\"change\":-1.89,\"quoteAt\":\"2026-09-10T08:53:21.301Z\",\"quoteSource\":null},{\"venue\":\"binance\",\"venue_name\":\"Binance\",\"symbol\":\"TENCENTUSDT\",\"company_key\":\"TENCENT\",\"company_name\":\"腾讯控股\",\"layer\":\"已上市公司\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"HK_EQUITY；按合约名称映射公司\",\"source_url\":\"https://fapi.binance.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:21.301Z\",\"price\":54.56546768,\"currency\":\"USD / USDT\",\"volume\":1154812.8812,\"oi\":null,\"funding\":0.00019829,\"interval\":4,\"nextFunding\":1789041600000,\"bid\":null,\"ask\":null,\"change\":-1.924,\"quoteAt\":\"2026-09-10T08:53:21.301Z\",\"quoteSource\":null},{\"venue\":\"binance\",\"venue_name\":\"Binance\",\"symbol\":\"POPMARTUSDT\",\"company_key\":\"POPMART\",\"company_name\":\"泡泡玛特\",\"layer\":\"已上市公司\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"HK_EQUITY；按合约名称映射公司\",\"source_url\":\"https://fapi.binance.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:21.301Z\",\"price\":19.41,\"currency\":\"USD / USDT\",\"volume\":947649.7293,\"oi\":null,\"funding\":0.00042605,\"interval\":4,\"nextFunding\":1789041600000,\"bid\":null,\"ask\":null,\"change\":-2.609,\"quoteAt\":\"2026-09-10T08:53:21.301Z\",\"quoteSource\":null},{\"venue\":\"binance\",\"venue_name\":\"Binance\",\"symbol\":\"GIGADEVUSDT\",\"company_key\":\"GIGADEV\",\"company_name\":\"兆易创新\",\"layer\":\"已上市公司\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"HK_EQUITY；按合约名称映射公司\",\"source_url\":\"https://fapi.binance.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:21.301Z\",\"price\":60.92065213,\"currency\":\"USD / USDT\",\"volume\":2874980.5515,\"oi\":null,\"funding\":0,\"interval\":4,\"nextFunding\":1789041600000,\"bid\":null,\"ask\":null,\"change\":-0.992,\"quoteAt\":\"2026-09-10T08:53:21.301Z\",\"quoteSource\":null},{\"venue\":\"binance\",\"venue_name\":\"Binance\",\"symbol\":\"KUAISHOUUSDT\",\"company_key\":\"KUAISHOU\",\"company_name\":\"快手科技\",\"layer\":\"已上市公司\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"HK_EQUITY；按合约名称映射公司\",\"source_url\":\"https://fapi.binance.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:21.301Z\",\"price\":4.039,\"currency\":\"USD / USDT\",\"volume\":670920.36536,\"oi\":null,\"funding\":0,\"interval\":4,\"nextFunding\":1789041600000,\"bid\":null,\"ask\":null,\"change\":-2.132,\"quoteAt\":\"2026-09-10T08:53:21.301Z\",\"quoteSource\":null},{\"venue\":\"binance\",\"venue_name\":\"Binance\",\"symbol\":\"MEITUANUSDT\",\"company_key\":\"MEITUAN\",\"company_name\":\"美团\",\"layer\":\"已上市公司\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"HK_EQUITY；按合约名称映射公司\",\"source_url\":\"https://fapi.binance.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:21.301Z\",\"price\":9.6,\"currency\":\"USD / USDT\",\"volume\":708095.7523,\"oi\":null,\"funding\":0.00045231,\"interval\":4,\"nextFunding\":1789041600000,\"bid\":null,\"ask\":null,\"change\":-3.518,\"quoteAt\":\"2026-09-10T08:53:21.301Z\",\"quoteSource\":null},{\"venue\":\"binance\",\"venue_name\":\"Binance\",\"symbol\":\"ZHONGJIUSDT\",\"company_key\":\"ZHONGJI\",\"company_name\":\"中际旭创\",\"layer\":\"已上市公司\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"HK_EQUITY；按合约名称映射公司\",\"source_url\":\"https://fapi.binance.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:21.301Z\",\"price\":143.07,\"currency\":\"USD / USDT\",\"volume\":9341670.5002,\"oi\":null,\"funding\":0,\"interval\":4,\"nextFunding\":1789041600000,\"bid\":null,\"ask\":null,\"change\":-4.531,\"quoteAt\":\"2026-09-10T08:53:21.301Z\",\"quoteSource\":null},{\"venue\":\"binance\",\"venue_name\":\"Binance\",\"symbol\":\"CXMTUSDT\",\"company_key\":\"CXMT\",\"company_name\":\"长鑫存储\",\"layer\":\"已上市公司\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"CN_EQUITY；按合约名称映射公司\",\"source_url\":\"https://fapi.binance.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:21.301Z\",\"price\":8.39944095,\"currency\":\"USD / USDT\",\"volume\":14944961.35799,\"oi\":null,\"funding\":-0.00187379,\"interval\":4,\"nextFunding\":1789041600000,\"bid\":null,\"ask\":null,\"change\":0.442,\"quoteAt\":\"2026-09-10T08:53:21.301Z\",\"quoteSource\":null},{\"venue\":\"binance\",\"venue_name\":\"Binance\",\"symbol\":\"UNITREEUSDT\",\"company_key\":\"UNITREE\",\"company_name\":\"宇树科技\",\"layer\":\"已上市公司\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"CN_EQUITY；按合约名称映射公司\",\"source_url\":\"https://fapi.binance.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:21.301Z\",\"price\":74.11,\"currency\":\"USD / USDT\",\"volume\":19563445.9556,\"oi\":null,\"funding\":-4.616e-05,\"interval\":4,\"nextFunding\":1789041600000,\"bid\":null,\"ask\":null,\"change\":-3.603,\"quoteAt\":\"2026-09-10T08:53:21.301Z\",\"quoteSource\":null},{\"venue\":\"binance\",\"venue_name\":\"Binance\",\"symbol\":\"PDDUSDT\",\"company_key\":\"PDD\",\"company_name\":\"拼多多\",\"layer\":\"美股中概补充\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"EQUITY；按合约名称映射公司\",\"source_url\":\"https://fapi.binance.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:21.301Z\",\"price\":78.84576196,\"currency\":\"USD / USDT\",\"volume\":313309.4065,\"oi\":null,\"funding\":0.00070475,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":-1.487,\"quoteAt\":\"2026-09-10T08:53:21.301Z\",\"quoteSource\":null},{\"venue\":\"binance\",\"venue_name\":\"Binance\",\"symbol\":\"HK0625USDT\",\"company_key\":\"SHEIN\",\"company_name\":\"SHEIN（希音）\",\"layer\":\"已上市公司\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"HK_EQUITY；按合约名称映射公司\",\"source_url\":\"https://fapi.binance.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:21.301Z\",\"price\":41.01427367,\"currency\":\"USD / USDT\",\"volume\":405581.1696,\"oi\":null,\"funding\":0,\"interval\":4,\"nextFunding\":1789041600000,\"bid\":null,\"ask\":null,\"change\":0.836,\"quoteAt\":\"2026-09-10T08:53:21.301Z\",\"quoteSource\":null},{\"venue\":\"binance\",\"venue_name\":\"Binance\",\"symbol\":\"BYDUSDT\",\"company_key\":\"BYD\",\"company_name\":\"比亚迪\",\"layer\":\"已上市公司\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"HK_EQUITY；按合约名称映射公司\",\"source_url\":\"https://fapi.binance.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:21.301Z\",\"price\":10.11470629,\"currency\":\"USD / USDT\",\"volume\":1752653.3651,\"oi\":null,\"funding\":0,\"interval\":4,\"nextFunding\":1789041600000,\"bid\":null,\"ask\":null,\"change\":-3.438,\"quoteAt\":\"2026-09-10T08:53:21.301Z\",\"quoteSource\":null},{\"venue\":\"binance\",\"venue_name\":\"Binance\",\"symbol\":\"HK0992USDT\",\"company_key\":\"LENOVO\",\"company_name\":\"联想集团\",\"layer\":\"已上市公司\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"HK_EQUITY；按合约名称映射公司\",\"source_url\":\"https://fapi.binance.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:21.301Z\",\"price\":32.2,\"currency\":\"USD / USDT\",\"volume\":679831.85,\"oi\":null,\"funding\":-0.00046076,\"interval\":4,\"nextFunding\":1789041600000,\"bid\":null,\"ask\":null,\"change\":-0.74,\"quoteAt\":\"2026-09-10T08:53:21.301Z\",\"quoteSource\":null}]},{\"venue\":\"bybit\",\"name\":\"Bybit\",\"observedAt\":\"2026-09-10T08:53:17.059Z\",\"attemptedAt\":\"2026-09-10T08:53:17.059Z\",\"error\":null,\"quoteError\":null,\"rows\":[{\"venue\":\"bybit\",\"venue_name\":\"Bybit\",\"symbol\":\"BABAUSDT\",\"company_key\":\"BABA\",\"company_name\":\"阿里巴巴\",\"layer\":\"美股中概补充\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"API: US / BABA\",\"source_url\":\"https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000\",\"fetched_at\":\"2026-09-10T08:53:17.059Z\",\"price\":109.17,\"currency\":\"USD / USDT\",\"volume\":305698.7577,\"oi\":1034800.6,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":109.17,\"ask\":109.21,\"change\":-2.7871,\"quoteAt\":\"2026-09-10T08:53:17.059Z\",\"quoteSource\":null},{\"venue\":\"bybit\",\"venue_name\":\"Bybit\",\"symbol\":\"BYDUSDT\",\"company_key\":\"BYD\",\"company_name\":\"比亚迪\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"API: HK / 1211HK\",\"source_url\":\"https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000\",\"fetched_at\":\"2026-09-10T08:53:17.059Z\",\"price\":10.13,\"currency\":\"USD / USDT\",\"volume\":52260.2825,\"oi\":43133.24,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":10.13,\"ask\":10.15,\"change\":-3.3396000000000003,\"quoteAt\":\"2026-09-10T08:53:17.059Z\",\"quoteSource\":null},{\"venue\":\"bybit\",\"venue_name\":\"Bybit\",\"symbol\":\"CXMTUSDT\",\"company_key\":\"CXMT\",\"company_name\":\"长鑫存储\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"API: CN / 688825\",\"source_url\":\"https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000\",\"fetched_at\":\"2026-09-10T08:53:17.059Z\",\"price\":8.39,\"currency\":\"USD / USDT\",\"volume\":3166710.9178,\"oi\":932239.75,\"funding\":-0.00160787,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":8.39,\"ask\":8.393,\"change\":0.44289999999999996,\"quoteAt\":\"2026-09-10T08:53:17.059Z\",\"quoteSource\":null},{\"venue\":\"bybit\",\"venue_name\":\"Bybit\",\"symbol\":\"FUTUUSDT\",\"company_key\":\"FUTU\",\"company_name\":\"富途控股\",\"layer\":\"美股中概补充\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"API: US / FUTU\",\"source_url\":\"https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000\",\"fetched_at\":\"2026-09-10T08:53:17.059Z\",\"price\":116.67,\"currency\":\"USD / USDT\",\"volume\":170437.7897,\"oi\":78455.91,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":116.61,\"ask\":116.71,\"change\":-1.2627,\"quoteAt\":\"2026-09-10T08:53:17.059Z\",\"quoteSource\":null},{\"venue\":\"bybit\",\"venue_name\":\"Bybit\",\"symbol\":\"GIGADEVICEUSDT\",\"company_key\":\"GIGADEV\",\"company_name\":\"兆易创新\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"API: HK / 03986\",\"source_url\":\"https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000\",\"fetched_at\":\"2026-09-10T08:53:17.059Z\",\"price\":60.98,\"currency\":\"USD / USDT\",\"volume\":43562.1585,\"oi\":180416.65,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":60.89,\"ask\":61.04,\"change\":-0.7163,\"quoteAt\":\"2026-09-10T08:53:17.059Z\",\"quoteSource\":null},{\"venue\":\"bybit\",\"venue_name\":\"Bybit\",\"symbol\":\"HUAHONGUSDT\",\"company_key\":\"HHGRACE\",\"company_name\":\"华虹半导体\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"API: HK / 1347HK\",\"source_url\":\"https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000\",\"fetched_at\":\"2026-09-10T08:53:17.059Z\",\"price\":14.95,\"currency\":\"USD / USDT\",\"volume\":187203.9895,\"oi\":63396.52,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":14.91,\"ask\":15,\"change\":5.8032,\"quoteAt\":\"2026-09-10T08:53:17.059Z\",\"quoteSource\":null},{\"venue\":\"bybit\",\"venue_name\":\"Bybit\",\"symbol\":\"JDUSDT\",\"company_key\":\"JD\",\"company_name\":\"京东\",\"layer\":\"美股中概补充\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"API: US / JD\",\"source_url\":\"https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000\",\"fetched_at\":\"2026-09-10T08:53:17.059Z\",\"price\":27.05,\"currency\":\"USD / USDT\",\"volume\":94446.8533,\"oi\":62476.84,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":27.05,\"ask\":27.09,\"change\":-1.2052,\"quoteAt\":\"2026-09-10T08:53:17.059Z\",\"quoteSource\":null},{\"venue\":\"bybit\",\"venue_name\":\"Bybit\",\"symbol\":\"KUAISHOUUSDT\",\"company_key\":\"KUAISHOU\",\"company_name\":\"快手科技\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"API: HK / 01024\",\"source_url\":\"https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000\",\"fetched_at\":\"2026-09-10T08:53:17.059Z\",\"price\":4.04,\"currency\":\"USD / USDT\",\"volume\":19323.712,\"oi\":56312.35,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":4.03,\"ask\":4.05,\"change\":-1.9369999999999998,\"quoteAt\":\"2026-09-10T08:53:17.059Z\",\"quoteSource\":null},{\"venue\":\"bybit\",\"venue_name\":\"Bybit\",\"symbol\":\"LAOPUUSDT\",\"company_key\":\"LAOPU\",\"company_name\":\"老铺黄金\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"API: HK / 6181HK\",\"source_url\":\"https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000\",\"fetched_at\":\"2026-09-10T08:53:17.059Z\",\"price\":48.61,\"currency\":\"USD / USDT\",\"volume\":58538.5134,\"oi\":51311.26,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":48.61,\"ask\":48.96,\"change\":-2.6046,\"quoteAt\":\"2026-09-10T08:53:17.059Z\",\"quoteSource\":null},{\"venue\":\"bybit\",\"venue_name\":\"Bybit\",\"symbol\":\"LENOVOUSDT\",\"company_key\":\"LENOVO\",\"company_name\":\"联想集团\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"API: HK / 992HK\",\"source_url\":\"https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000\",\"fetched_at\":\"2026-09-10T08:53:17.059Z\",\"price\":4.088,\"currency\":\"USD / USDT\",\"volume\":84471.0854,\"oi\":64575.68,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":4.088,\"ask\":4.09,\"change\":-0.8488000000000001,\"quoteAt\":\"2026-09-10T08:53:17.059Z\",\"quoteSource\":null},{\"venue\":\"bybit\",\"venue_name\":\"Bybit\",\"symbol\":\"MEITUANUSDT\",\"company_key\":\"MEITUAN\",\"company_name\":\"美团\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"API: HK / 03690\",\"source_url\":\"https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000\",\"fetched_at\":\"2026-09-10T08:53:17.059Z\",\"price\":9.61,\"currency\":\"USD / USDT\",\"volume\":7866.7754,\"oi\":16383.61,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":9.59,\"ask\":9.63,\"change\":-3.015,\"quoteAt\":\"2026-09-10T08:53:17.059Z\",\"quoteSource\":null},{\"venue\":\"bybit\",\"venue_name\":\"Bybit\",\"symbol\":\"MINIMAXUSDT\",\"company_key\":\"MINIMAX\",\"company_name\":\"MiniMax（稀宇科技）\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"API: HK / 00100\",\"source_url\":\"https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000\",\"fetched_at\":\"2026-09-10T08:53:17.059Z\",\"price\":37.33,\"currency\":\"USD / USDT\",\"volume\":363249.7923,\"oi\":171695.23,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":37.31,\"ask\":37.34,\"change\":-9.8067,\"quoteAt\":\"2026-09-10T08:53:17.059Z\",\"quoteSource\":null},{\"venue\":\"bybit\",\"venue_name\":\"Bybit\",\"symbol\":\"PDDUSDT\",\"company_key\":\"PDD\",\"company_name\":\"拼多多\",\"layer\":\"美股中概补充\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"API: US / PDD\",\"source_url\":\"https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000\",\"fetched_at\":\"2026-09-10T08:53:17.059Z\",\"price\":78.9,\"currency\":\"USD / USDT\",\"volume\":27430.043,\"oi\":78069.18,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":78.92,\"ask\":79.02,\"change\":-1.7923000000000002,\"quoteAt\":\"2026-09-10T08:53:17.059Z\",\"quoteSource\":null},{\"venue\":\"bybit\",\"venue_name\":\"Bybit\",\"symbol\":\"POPMARTUSDT\",\"company_key\":\"POPMART\",\"company_name\":\"泡泡玛特\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"API: HK / 09992\",\"source_url\":\"https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000\",\"fetched_at\":\"2026-09-10T08:53:17.059Z\",\"price\":19.43,\"currency\":\"USD / USDT\",\"volume\":5827.7525,\"oi\":27619.16,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":19.39,\"ask\":19.46,\"change\":-2.013,\"quoteAt\":\"2026-09-10T08:53:17.059Z\",\"quoteSource\":null},{\"venue\":\"bybit\",\"venue_name\":\"Bybit\",\"symbol\":\"SHEINUSDT\",\"company_key\":\"SHEIN\",\"company_name\":\"SHEIN（希音）\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"API: HK / SHEIN\",\"source_url\":\"https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000\",\"fetched_at\":\"2026-09-10T08:53:17.059Z\",\"price\":5.23,\"currency\":\"USD / USDT\",\"volume\":91930.397,\"oi\":94820.95,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":5.21,\"ask\":5.23,\"change\":0.7707,\"quoteAt\":\"2026-09-10T08:53:17.059Z\",\"quoteSource\":null},{\"venue\":\"bybit\",\"venue_name\":\"Bybit\",\"symbol\":\"SMICUSDT\",\"company_key\":\"SMIC\",\"company_name\":\"中芯国际\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"API=US/SMIC 与历史H股证据冲突；当前指数8.08与Lighter H0981的8.0727接近，仅交叉支持H股\",\"source_url\":\"https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000\",\"fetched_at\":\"2026-09-10T08:53:17.059Z\",\"price\":8.16,\"currency\":\"USD / USDT\",\"volume\":84246.084,\"oi\":51451.25,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":8.11,\"ask\":8.14,\"change\":-2.2754,\"quoteAt\":\"2026-09-10T08:53:17.059Z\",\"quoteSource\":null},{\"venue\":\"bybit\",\"venue_name\":\"Bybit\",\"symbol\":\"TENCENTUSDT\",\"company_key\":\"TENCENT\",\"company_name\":\"腾讯控股\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"API: HK / 00700\",\"source_url\":\"https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000\",\"fetched_at\":\"2026-09-10T08:53:17.059Z\",\"price\":54.54,\"currency\":\"USD / USDT\",\"volume\":34765.8551,\"oi\":120206.71,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":54.54,\"ask\":54.69,\"change\":-1.9777,\"quoteAt\":\"2026-09-10T08:53:17.059Z\",\"quoteSource\":null},{\"venue\":\"bybit\",\"venue_name\":\"Bybit\",\"symbol\":\"UNITREEUSDT\",\"company_key\":\"UNITREE\",\"company_name\":\"宇树科技\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"API: CN / UNITREE\",\"source_url\":\"https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000\",\"fetched_at\":\"2026-09-10T08:53:17.059Z\",\"price\":74.11,\"currency\":\"USD / USDT\",\"volume\":890092.7227,\"oi\":649296.24,\"funding\":-0.00053622,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":74.11,\"ask\":74.14,\"change\":-3.5904,\"quoteAt\":\"2026-09-10T08:53:17.059Z\",\"quoteSource\":null},{\"venue\":\"bybit\",\"venue_name\":\"Bybit\",\"symbol\":\"XIAOMIUSDT\",\"company_key\":\"XIAOMI\",\"company_name\":\"小米集团\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"API: HK / 01810\",\"source_url\":\"https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000\",\"fetched_at\":\"2026-09-10T08:53:17.059Z\",\"price\":3.318,\"currency\":\"USD / USDT\",\"volume\":66852.1398,\"oi\":101506.91,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":3.311,\"ask\":3.32,\"change\":-1.8922999999999999,\"quoteAt\":\"2026-09-10T08:53:17.059Z\",\"quoteSource\":null},{\"venue\":\"bybit\",\"venue_name\":\"Bybit\",\"symbol\":\"YOFCUSDT\",\"company_key\":\"YOFC\",\"company_name\":\"长飞光纤光缆\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"API: HK / 6869HK\",\"source_url\":\"https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000\",\"fetched_at\":\"2026-09-10T08:53:17.059Z\",\"price\":22.59,\"currency\":\"USD / USDT\",\"volume\":78189.9147,\"oi\":31347.24,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":22.46,\"ask\":22.59,\"change\":-0.6596000000000001,\"quoteAt\":\"2026-09-10T08:53:17.059Z\",\"quoteSource\":null},{\"venue\":\"bybit\",\"venue_name\":\"Bybit\",\"symbol\":\"ZHIPUUSDT\",\"company_key\":\"ZHIPU\",\"company_name\":\"智谱\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"API: HK / 02513\",\"source_url\":\"https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000\",\"fetched_at\":\"2026-09-10T08:53:17.059Z\",\"price\":104.6,\"currency\":\"USD / USDT\",\"volume\":600946.6266,\"oi\":145196.31,\"funding\":0.00051887,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":104.6,\"ask\":104.66,\"change\":-10.9028,\"quoteAt\":\"2026-09-10T08:53:17.059Z\",\"quoteSource\":null},{\"venue\":\"bybit\",\"venue_name\":\"Bybit\",\"symbol\":\"ZHONGJIUSDT\",\"company_key\":\"ZHONGJI\",\"company_name\":\"中际旭创\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"API: HK / 03308\",\"source_url\":\"https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000\",\"fetched_at\":\"2026-09-10T08:53:17.059Z\",\"price\":143.14,\"currency\":\"USD / USDT\",\"volume\":98626.5807,\"oi\":33458.98,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":142.86,\"ask\":143.03,\"change\":-4.3658,\"quoteAt\":\"2026-09-10T08:53:17.059Z\",\"quoteSource\":null}]},{\"venue\":\"bitget\",\"name\":\"Bitget\",\"observedAt\":\"2026-09-10T08:53:20.881Z\",\"attemptedAt\":\"2026-09-10T08:53:20.881Z\",\"error\":null,\"quoteError\":null,\"rows\":[{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"BABAUSDT\",\"company_key\":\"BABA\",\"company_name\":\"阿里巴巴\",\"layer\":\"美股中概补充\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":109.1,\"currency\":\"USD / USDT\",\"volume\":957436.6956,\"oi\":null,\"funding\":0,\"interval\":8,\"nextFunding\":null,\"bid\":109.14,\"ask\":109.16,\"change\":-2.841,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"FUTUUSDT\",\"company_key\":\"FUTU\",\"company_name\":\"富途控股\",\"layer\":\"美股中概补充\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":116.86,\"currency\":\"USD / USDT\",\"volume\":42728.1576,\"oi\":null,\"funding\":0,\"interval\":8,\"nextFunding\":null,\"bid\":116.82,\"ask\":116.89,\"change\":-0.9740000000000001,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"JDUSDT\",\"company_key\":\"JD\",\"company_name\":\"京东\",\"layer\":\"美股中概补充\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":26.96,\"currency\":\"USD / USDT\",\"volume\":30677.3597,\"oi\":null,\"funding\":0,\"interval\":8,\"nextFunding\":null,\"bid\":26.95,\"ask\":26.97,\"change\":-1.209,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"NIOUSDT\",\"company_key\":\"NIO\",\"company_name\":\"蔚来\",\"layer\":\"美股中概补充\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":3.666,\"currency\":\"USD / USDT\",\"volume\":84074.39587,\"oi\":null,\"funding\":0,\"interval\":8,\"nextFunding\":null,\"bid\":3.663,\"ask\":3.679,\"change\":-4.007000000000001,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"MINIMAXUSDT\",\"company_key\":\"MINIMAX\",\"company_name\":\"MiniMax（稀宇科技）\",\"layer\":\"已上市公司\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":37.311,\"currency\":\"USD / USDT\",\"volume\":1898872.2774,\"oi\":null,\"funding\":0.000291,\"interval\":8,\"nextFunding\":null,\"bid\":37.301,\"ask\":37.307,\"change\":-9.849,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"ZHIPUUSDT\",\"company_key\":\"ZHIPU\",\"company_name\":\"智谱\",\"layer\":\"已上市公司\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":104.63,\"currency\":\"USD / USDT\",\"volume\":2437056.0797,\"oi\":null,\"funding\":0.001299,\"interval\":8,\"nextFunding\":null,\"bid\":104.62,\"ask\":104.63,\"change\":-10.91,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"PDDUSDT\",\"company_key\":\"PDD\",\"company_name\":\"拼多多\",\"layer\":\"美股中概补充\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":78.71,\"currency\":\"USD / USDT\",\"volume\":51142.8234,\"oi\":null,\"funding\":0,\"interval\":8,\"nextFunding\":null,\"bid\":78.65,\"ask\":78.77,\"change\":-1.4869999999999999,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"TENCENTUSDT\",\"company_key\":\"TENCENT\",\"company_name\":\"腾讯控股\",\"layer\":\"已上市公司\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":54.63,\"currency\":\"USD / USDT\",\"volume\":230347.98,\"oi\":null,\"funding\":1.4e-05,\"interval\":8,\"nextFunding\":null,\"bid\":54.64,\"ask\":54.68,\"change\":-1.974,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"GIGADEVICEUSDT\",\"company_key\":\"GIGADEV\",\"company_name\":\"兆易创新\",\"layer\":\"已上市公司\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":60.73,\"currency\":\"USD / USDT\",\"volume\":92319.2669,\"oi\":null,\"funding\":0,\"interval\":8,\"nextFunding\":null,\"bid\":60.68,\"ask\":60.78,\"change\":-0.979,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"SMICUSDT\",\"company_key\":\"SMIC\",\"company_name\":\"中芯国际\",\"layer\":\"已上市公司\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":8.095,\"currency\":\"USD / USDT\",\"volume\":82325.09558,\"oi\":null,\"funding\":0,\"interval\":8,\"nextFunding\":null,\"bid\":8.091,\"ask\":8.1,\"change\":-2.717,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"POPMARTUSDT\",\"company_key\":\"POPMART\",\"company_name\":\"泡泡玛特\",\"layer\":\"已上市公司\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":19.478,\"currency\":\"USD / USDT\",\"volume\":143693.64801,\"oi\":null,\"funding\":0,\"interval\":8,\"nextFunding\":null,\"bid\":19.464,\"ask\":19.485,\"change\":-2.3120000000000003,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"XIAOMIUSDT\",\"company_key\":\"XIAOMI\",\"company_name\":\"小米集团\",\"layer\":\"已上市公司\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":3.3235,\"currency\":\"USD / USDT\",\"volume\":263668.768491,\"oi\":null,\"funding\":0.000509,\"interval\":8,\"nextFunding\":null,\"bid\":3.3213,\"ask\":3.3223,\"change\":-1.504,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"MEITUANUSDT\",\"company_key\":\"MEITUAN\",\"company_name\":\"美团\",\"layer\":\"已上市公司\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":9.61,\"currency\":\"USD / USDT\",\"volume\":211044.94847,\"oi\":null,\"funding\":2e-06,\"interval\":8,\"nextFunding\":null,\"bid\":9.608,\"ask\":9.616,\"change\":-3.4619999999999997,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"NETEASEUSDT\",\"company_key\":\"NETEASE\",\"company_name\":\"网易\",\"layer\":\"美股中概补充\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":23.353,\"currency\":\"USD / USDT\",\"volume\":39007.03767,\"oi\":null,\"funding\":0,\"interval\":8,\"nextFunding\":null,\"bid\":23.34,\"ask\":23.366,\"change\":-0.509,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"KUAISHOUUSDT\",\"company_key\":\"KUAISHOU\",\"company_name\":\"快手科技\",\"layer\":\"已上市公司\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":4.044,\"currency\":\"USD / USDT\",\"volume\":129235.89985,\"oi\":null,\"funding\":0,\"interval\":8,\"nextFunding\":null,\"bid\":4.047,\"ask\":4.05,\"change\":-2.13,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"MINIMAXHKDUSDT\",\"company_key\":\"MINIMAX\",\"company_name\":\"MiniMax（稀宇科技）\",\"layer\":\"已上市公司\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":292.15,\"currency\":\"HKD 数值 / USDT quanto\",\"volume\":436897.648,\"oi\":null,\"funding\":0,\"interval\":8,\"nextFunding\":null,\"bid\":291.96,\"ask\":292.34,\"change\":-9.807,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"XIAOMIHKDUSDT\",\"company_key\":\"XIAOMI\",\"company_name\":\"小米集团\",\"layer\":\"已上市公司\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":25.986,\"currency\":\"HKD 数值 / USDT quanto\",\"volume\":253437.42052,\"oi\":null,\"funding\":0,\"interval\":8,\"nextFunding\":null,\"bid\":25.977,\"ask\":25.986,\"change\":-1.828,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"TENCENTHKDUSDT\",\"company_key\":\"TENCENT\",\"company_name\":\"腾讯控股\",\"layer\":\"已上市公司\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":426.96,\"currency\":\"HKD 数值 / USDT quanto\",\"volume\":241445.9125,\"oi\":null,\"funding\":0,\"interval\":8,\"nextFunding\":null,\"bid\":427.16,\"ask\":427.31,\"change\":-2.0060000000000002,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"ZHIPUHKDUSDT\",\"company_key\":\"ZHIPU\",\"company_name\":\"智谱\",\"layer\":\"已上市公司\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":816.78,\"currency\":\"HKD 数值 / USDT quanto\",\"volume\":952472.1582,\"oi\":null,\"funding\":0,\"interval\":8,\"nextFunding\":null,\"bid\":816.69,\"ask\":816.86,\"change\":-10.947,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"MOONSHOTUSDT\",\"company_key\":\"KIMI\",\"company_name\":\"月之暗面 / Kimi\",\"layer\":\"预上市补充\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"预上市价格预期；不等同于上市后股价\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":71.64,\"currency\":\"USD / USDT\",\"volume\":51436.1968,\"oi\":null,\"funding\":0,\"interval\":8,\"nextFunding\":null,\"bid\":71.62,\"ask\":71.66,\"change\":-0.899,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"LENOVOHKDUSDT\",\"company_key\":\"LENOVO\",\"company_name\":\"联想集团\",\"layer\":\"已上市公司\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":32.245,\"currency\":\"HKD 数值 / USDT quanto\",\"volume\":70067.00964,\"oi\":null,\"funding\":0,\"interval\":8,\"nextFunding\":null,\"bid\":32.236,\"ask\":32.255,\"change\":-0.528,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"ZHONGJIUSDT\",\"company_key\":\"ZHONGJI\",\"company_name\":\"中际旭创\",\"layer\":\"已上市公司\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":143.12,\"currency\":\"USD / USDT\",\"volume\":1873345.226,\"oi\":null,\"funding\":0.000362,\"interval\":8,\"nextFunding\":null,\"bid\":143.07,\"ask\":143.17,\"change\":-4.53,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"CXMTUSDT\",\"company_key\":\"CXMT\",\"company_name\":\"长鑫存储\",\"layer\":\"已上市公司\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":8.396,\"currency\":\"USD / USDT\",\"volume\":2300362.75477,\"oi\":null,\"funding\":-0.004774,\"interval\":8,\"nextFunding\":null,\"bid\":8.394,\"ask\":8.395,\"change\":0.611,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"UNITREEUSDT\",\"company_key\":\"UNITREE\",\"company_name\":\"宇树科技\",\"layer\":\"已上市公司\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":74.09,\"currency\":\"USD / USDT\",\"volume\":966402.6047,\"oi\":null,\"funding\":-1.7e-05,\"interval\":4,\"nextFunding\":null,\"bid\":74.07,\"ask\":74.08,\"change\":-3.6159999999999997,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"SHEINUSDT\",\"company_key\":\"SHEIN\",\"company_name\":\"SHEIN（希音）\",\"layer\":\"已上市公司\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":5.235,\"currency\":\"USD / USDT\",\"volume\":504652.1859,\"oi\":null,\"funding\":0,\"interval\":8,\"nextFunding\":null,\"bid\":5.236,\"ask\":5.247,\"change\":1.042,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"SHEINHKDUSDT\",\"company_key\":\"SHEIN\",\"company_name\":\"SHEIN（希音）\",\"layer\":\"已上市公司\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":40.99,\"currency\":\"HKD 数值 / USDT quanto\",\"volume\":208641.5256,\"oi\":null,\"funding\":0,\"interval\":8,\"nextFunding\":null,\"bid\":40.97,\"ask\":41.01,\"change\":0.985,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null},{\"venue\":\"bitget\",\"venue_name\":\"Bitget\",\"symbol\":\"BYDUSDT\",\"company_key\":\"BYD\",\"company_name\":\"比亚迪\",\"layer\":\"已上市公司\",\"status\":\"normal\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES\",\"fetched_at\":\"2026-09-10T08:53:20.881Z\",\"price\":10.132,\"currency\":\"USD / USDT\",\"volume\":560952.20895,\"oi\":null,\"funding\":0.000148,\"interval\":8,\"nextFunding\":null,\"bid\":10.117,\"ask\":10.129,\"change\":-3.2099999999999995,\"quoteAt\":\"2026-09-10T08:53:20.881Z\",\"quoteSource\":null}]},{\"venue\":\"mexc\",\"name\":\"MEXC\",\"observedAt\":\"2026-09-10T08:53:21.277Z\",\"attemptedAt\":\"2026-09-10T08:53:21.277Z\",\"error\":null,\"quoteError\":null,\"rows\":[{\"venue\":\"mexc\",\"venue_name\":\"MEXC\",\"symbol\":\"UNITREE_USDT\",\"company_key\":\"UNITREE\",\"company_name\":\"宇树科技\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://contract.mexc.com/api/v1/contract/detail\",\"fetched_at\":\"2026-09-10T08:53:21.277Z\",\"price\":74.12,\"currency\":\"USD / USDT\",\"volume\":491995.995,\"oi\":null,\"funding\":-4.2e-05,\"interval\":null,\"nextFunding\":null,\"bid\":74.1,\"ask\":74.13,\"change\":-3.1399999999999997,\"quoteAt\":\"2026-09-10T08:53:21.277Z\",\"quoteSource\":null},{\"venue\":\"mexc\",\"venue_name\":\"MEXC\",\"symbol\":\"SHEINSTOCK_USDT\",\"company_key\":\"SHEIN\",\"company_name\":\"SHEIN（希音）\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://contract.mexc.com/api/v1/contract/detail\",\"fetched_at\":\"2026-09-10T08:53:21.277Z\",\"price\":5.238,\"currency\":\"USD / USDT\",\"volume\":200111.24878,\"oi\":null,\"funding\":0,\"interval\":null,\"nextFunding\":null,\"bid\":5.236,\"ask\":5.243,\"change\":1.3299999999999998,\"quoteAt\":\"2026-09-10T08:53:21.277Z\",\"quoteSource\":null},{\"venue\":\"mexc\",\"venue_name\":\"MEXC\",\"symbol\":\"ZHIPUSTOCK_USDT\",\"company_key\":\"ZHIPU\",\"company_name\":\"智谱\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://contract.mexc.com/api/v1/contract/detail\",\"fetched_at\":\"2026-09-10T08:53:21.277Z\",\"price\":104.55,\"currency\":\"USD / USDT\",\"volume\":266942.1011,\"oi\":null,\"funding\":0.000644,\"interval\":null,\"nextFunding\":null,\"bid\":104.49,\"ask\":104.57,\"change\":-10.12,\"quoteAt\":\"2026-09-10T08:53:21.277Z\",\"quoteSource\":null},{\"venue\":\"mexc\",\"venue_name\":\"MEXC\",\"symbol\":\"CXMTSTOCK_USDT\",\"company_key\":\"CXMT\",\"company_name\":\"长鑫存储\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://contract.mexc.com/api/v1/contract/detail\",\"fetched_at\":\"2026-09-10T08:53:21.277Z\",\"price\":8.392,\"currency\":\"USD / USDT\",\"volume\":215520.9532,\"oi\":null,\"funding\":-0.000199,\"interval\":null,\"nextFunding\":null,\"bid\":8.384,\"ask\":8.405,\"change\":0.19,\"quoteAt\":\"2026-09-10T08:53:21.277Z\",\"quoteSource\":null},{\"venue\":\"mexc\",\"venue_name\":\"MEXC\",\"symbol\":\"BABASTOCK_USDT\",\"company_key\":\"BABA\",\"company_name\":\"阿里巴巴\",\"layer\":\"美股中概补充\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://contract.mexc.com/api/v1/contract/detail\",\"fetched_at\":\"2026-09-10T08:53:21.277Z\",\"price\":109.17,\"currency\":\"USD / USDT\",\"volume\":157474.0566,\"oi\":null,\"funding\":5.5e-05,\"interval\":null,\"nextFunding\":null,\"bid\":109.16,\"ask\":109.17,\"change\":-0.58,\"quoteAt\":\"2026-09-10T08:53:21.277Z\",\"quoteSource\":null},{\"venue\":\"mexc\",\"venue_name\":\"MEXC\",\"symbol\":\"XIAOMISTOCK_USDT\",\"company_key\":\"XIAOMI\",\"company_name\":\"小米集团\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://contract.mexc.com/api/v1/contract/detail\",\"fetched_at\":\"2026-09-10T08:53:21.277Z\",\"price\":3.323,\"currency\":\"USD / USDT\",\"volume\":92618.363,\"oi\":null,\"funding\":0.000514,\"interval\":null,\"nextFunding\":null,\"bid\":3.318,\"ask\":3.333,\"change\":-1.39,\"quoteAt\":\"2026-09-10T08:53:21.277Z\",\"quoteSource\":null},{\"venue\":\"mexc\",\"venue_name\":\"MEXC\",\"symbol\":\"ZHONGJISTOCK_USDT\",\"company_key\":\"ZHONGJI\",\"company_name\":\"中际旭创\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://contract.mexc.com/api/v1/contract/detail\",\"fetched_at\":\"2026-09-10T08:53:21.277Z\",\"price\":143.06,\"currency\":\"USD / USDT\",\"volume\":134790.36477,\"oi\":null,\"funding\":0,\"interval\":null,\"nextFunding\":null,\"bid\":143.05,\"ask\":143.08,\"change\":-2.42,\"quoteAt\":\"2026-09-10T08:53:21.277Z\",\"quoteSource\":null},{\"venue\":\"mexc\",\"venue_name\":\"MEXC\",\"symbol\":\"MINIMAXSTOCK_USDT\",\"company_key\":\"MINIMAX\",\"company_name\":\"MiniMax（稀宇科技）\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://contract.mexc.com/api/v1/contract/detail\",\"fetched_at\":\"2026-09-10T08:53:21.277Z\",\"price\":37.29,\"currency\":\"USD / USDT\",\"volume\":96572.3167,\"oi\":null,\"funding\":1.4e-05,\"interval\":null,\"nextFunding\":null,\"bid\":37.29,\"ask\":37.3,\"change\":-9.02,\"quoteAt\":\"2026-09-10T08:53:21.277Z\",\"quoteSource\":null},{\"venue\":\"mexc\",\"venue_name\":\"MEXC\",\"symbol\":\"YMTCSTOCK_USDT\",\"company_key\":\"YMTC\",\"company_name\":\"长江存储\",\"layer\":\"预上市补充\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"预上市价格预期；不等同于上市后股价\",\"source_url\":\"https://contract.mexc.com/api/v1/contract/detail\",\"fetched_at\":\"2026-09-10T08:53:21.277Z\",\"price\":12.689,\"currency\":\"USD / USDT\",\"volume\":86452.26356,\"oi\":null,\"funding\":0.0002,\"interval\":null,\"nextFunding\":null,\"bid\":12.674,\"ask\":12.74,\"change\":-1.24,\"quoteAt\":\"2026-09-10T08:53:21.277Z\",\"quoteSource\":null},{\"venue\":\"mexc\",\"venue_name\":\"MEXC\",\"symbol\":\"KIMISTOCK_USDT\",\"company_key\":\"KIMI\",\"company_name\":\"月之暗面 / Kimi\",\"layer\":\"预上市补充\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"预上市价格预期；不等同于上市后股价\",\"source_url\":\"https://contract.mexc.com/api/v1/contract/detail\",\"fetched_at\":\"2026-09-10T08:53:21.277Z\",\"price\":8.008,\"currency\":\"USD / USDT\",\"volume\":85515.4533,\"oi\":null,\"funding\":0.00013,\"interval\":null,\"nextFunding\":null,\"bid\":7.973,\"ask\":8.039,\"change\":0.02,\"quoteAt\":\"2026-09-10T08:53:21.277Z\",\"quoteSource\":null},{\"venue\":\"mexc\",\"venue_name\":\"MEXC\",\"symbol\":\"BIDUSTOCK_USDT\",\"company_key\":\"BIDU\",\"company_name\":\"百度\",\"layer\":\"美股中概补充\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://contract.mexc.com/api/v1/contract/detail\",\"fetched_at\":\"2026-09-10T08:53:21.277Z\",\"price\":90.83,\"currency\":\"USD / USDT\",\"volume\":92668.8162,\"oi\":null,\"funding\":-0.000114,\"interval\":null,\"nextFunding\":null,\"bid\":90.74,\"ask\":90.93,\"change\":-1.32,\"quoteAt\":\"2026-09-10T08:53:21.277Z\",\"quoteSource\":null},{\"venue\":\"mexc\",\"venue_name\":\"MEXC\",\"symbol\":\"NIOSTOCK_USDT\",\"company_key\":\"NIO\",\"company_name\":\"蔚来\",\"layer\":\"美股中概补充\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://contract.mexc.com/api/v1/contract/detail\",\"fetched_at\":\"2026-09-10T08:53:21.277Z\",\"price\":3.666,\"currency\":\"USD / USDT\",\"volume\":83661.515,\"oi\":null,\"funding\":0,\"interval\":null,\"nextFunding\":null,\"bid\":3.657,\"ask\":3.687,\"change\":-0.9900000000000001,\"quoteAt\":\"2026-09-10T08:53:21.277Z\",\"quoteSource\":null},{\"venue\":\"mexc\",\"venue_name\":\"MEXC\",\"symbol\":\"GIGADEVSTOCK_USDT\",\"company_key\":\"GIGADEV\",\"company_name\":\"兆易创新\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://contract.mexc.com/api/v1/contract/detail\",\"fetched_at\":\"2026-09-10T08:53:21.277Z\",\"price\":60.91,\"currency\":\"USD / USDT\",\"volume\":104282.3347,\"oi\":null,\"funding\":0,\"interval\":null,\"nextFunding\":null,\"bid\":60.91,\"ask\":60.94,\"change\":-1.8499999999999999,\"quoteAt\":\"2026-09-10T08:53:21.277Z\",\"quoteSource\":null},{\"venue\":\"mexc\",\"venue_name\":\"MEXC\",\"symbol\":\"PDDSTOCK_USDT\",\"company_key\":\"PDD\",\"company_name\":\"拼多多\",\"layer\":\"美股中概补充\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://contract.mexc.com/api/v1/contract/detail\",\"fetched_at\":\"2026-09-10T08:53:21.277Z\",\"price\":78.85,\"currency\":\"USD / USDT\",\"volume\":78130.4993,\"oi\":null,\"funding\":0.000702,\"interval\":null,\"nextFunding\":null,\"bid\":78.64,\"ask\":79.06,\"change\":-0.05,\"quoteAt\":\"2026-09-10T08:53:21.277Z\",\"quoteSource\":null},{\"venue\":\"mexc\",\"venue_name\":\"MEXC\",\"symbol\":\"MEITUANSTOCK_USDT\",\"company_key\":\"MEITUAN\",\"company_name\":\"美团\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://contract.mexc.com/api/v1/contract/detail\",\"fetched_at\":\"2026-09-10T08:53:21.277Z\",\"price\":9.59,\"currency\":\"USD / USDT\",\"volume\":98356.194,\"oi\":null,\"funding\":0.000459,\"interval\":null,\"nextFunding\":null,\"bid\":9.59,\"ask\":9.6,\"change\":-2.73,\"quoteAt\":\"2026-09-10T08:53:21.277Z\",\"quoteSource\":null},{\"venue\":\"mexc\",\"venue_name\":\"MEXC\",\"symbol\":\"JDSTOCK_USDT\",\"company_key\":\"JD\",\"company_name\":\"京东\",\"layer\":\"美股中概补充\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://contract.mexc.com/api/v1/contract/detail\",\"fetched_at\":\"2026-09-10T08:53:21.277Z\",\"price\":26.93,\"currency\":\"USD / USDT\",\"volume\":83031.7527,\"oi\":null,\"funding\":0,\"interval\":null,\"nextFunding\":null,\"bid\":26.93,\"ask\":26.98,\"change\":-0.03,\"quoteAt\":\"2026-09-10T08:53:21.277Z\",\"quoteSource\":null},{\"venue\":\"mexc\",\"venue_name\":\"MEXC\",\"symbol\":\"HK1810_USDT\",\"company_key\":\"XIAOMI\",\"company_name\":\"小米集团\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://contract.mexc.com/api/v1/contract/detail\",\"fetched_at\":\"2026-09-10T08:53:21.277Z\",\"price\":25.95,\"currency\":\"USD / USDT\",\"volume\":92712.206,\"oi\":null,\"funding\":0.000233,\"interval\":null,\"nextFunding\":null,\"bid\":25.95,\"ask\":25.96,\"change\":-1.55,\"quoteAt\":\"2026-09-10T08:53:21.277Z\",\"quoteSource\":null},{\"venue\":\"mexc\",\"venue_name\":\"MEXC\",\"symbol\":\"HK0700_USDT\",\"company_key\":\"TENCENT\",\"company_name\":\"腾讯控股\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://contract.mexc.com/api/v1/contract/detail\",\"fetched_at\":\"2026-09-10T08:53:21.277Z\",\"price\":426.9,\"currency\":\"USD / USDT\",\"volume\":86215.342,\"oi\":null,\"funding\":0,\"interval\":null,\"nextFunding\":null,\"bid\":426.78,\"ask\":426.99,\"change\":-1.6500000000000001,\"quoteAt\":\"2026-09-10T08:53:21.277Z\",\"quoteSource\":null},{\"venue\":\"mexc\",\"venue_name\":\"MEXC\",\"symbol\":\"POPMARTSTOCK_USDT\",\"company_key\":\"POPMART\",\"company_name\":\"泡泡玛特\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://contract.mexc.com/api/v1/contract/detail\",\"fetched_at\":\"2026-09-10T08:53:21.277Z\",\"price\":19.41,\"currency\":\"USD / USDT\",\"volume\":110794.845,\"oi\":null,\"funding\":0.000432,\"interval\":null,\"nextFunding\":null,\"bid\":19.4,\"ask\":19.42,\"change\":-2.5100000000000002,\"quoteAt\":\"2026-09-10T08:53:21.277Z\",\"quoteSource\":null},{\"venue\":\"mexc\",\"venue_name\":\"MEXC\",\"symbol\":\"KUAISHOUSTOCK_USDT\",\"company_key\":\"KUAISHOU\",\"company_name\":\"快手科技\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://contract.mexc.com/api/v1/contract/detail\",\"fetched_at\":\"2026-09-10T08:53:21.277Z\",\"price\":4.038,\"currency\":\"USD / USDT\",\"volume\":89317.7335,\"oi\":null,\"funding\":0,\"interval\":null,\"nextFunding\":null,\"bid\":4.038,\"ask\":4.039,\"change\":-1.7500000000000002,\"quoteAt\":\"2026-09-10T08:53:21.277Z\",\"quoteSource\":null},{\"venue\":\"mexc\",\"venue_name\":\"MEXC\",\"symbol\":\"TENCENTSTOCK_USDT\",\"company_key\":\"TENCENT\",\"company_name\":\"腾讯控股\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://contract.mexc.com/api/v1/contract/detail\",\"fetched_at\":\"2026-09-10T08:53:21.277Z\",\"price\":54.56,\"currency\":\"USD / USDT\",\"volume\":79132.4983,\"oi\":null,\"funding\":0.000203,\"interval\":null,\"nextFunding\":null,\"bid\":54.55,\"ask\":54.58,\"change\":-1.55,\"quoteAt\":\"2026-09-10T08:53:21.277Z\",\"quoteSource\":null},{\"venue\":\"mexc\",\"venue_name\":\"MEXC\",\"symbol\":\"FUTUSTOCK_USDT\",\"company_key\":\"FUTU\",\"company_name\":\"富途控股\",\"layer\":\"美股中概补充\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://contract.mexc.com/api/v1/contract/detail\",\"fetched_at\":\"2026-09-10T08:53:21.277Z\",\"price\":116.85,\"currency\":\"USD / USDT\",\"volume\":82774.3779,\"oi\":null,\"funding\":0,\"interval\":null,\"nextFunding\":null,\"bid\":116.82,\"ask\":116.89,\"change\":-0.58,\"quoteAt\":\"2026-09-10T08:53:21.277Z\",\"quoteSource\":null}]},{\"venue\":\"kucoin\",\"name\":\"KuCoin\",\"observedAt\":\"2026-09-10T08:53:24.574Z\",\"attemptedAt\":\"2026-09-10T08:53:24.574Z\",\"error\":null,\"quoteError\":null,\"rows\":[{\"venue\":\"kucoin\",\"venue_name\":\"KuCoin\",\"symbol\":\"BABAUSDTM\",\"company_key\":\"BABA\",\"company_name\":\"阿里巴巴\",\"layer\":\"美股中概补充\",\"status\":\"Open\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"US.STOCK\",\"source_url\":\"https://api-futures.kucoin.com/api/v1/contracts/active\",\"fetched_at\":\"2026-09-10T08:53:24.574Z\",\"price\":109.14,\"currency\":\"USD / USDT\",\"volume\":508228.1198,\"oi\":null,\"funding\":0.0001,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":-2.7,\"quoteAt\":\"2026-09-10T08:53:24.574Z\",\"quoteSource\":null},{\"venue\":\"kucoin\",\"venue_name\":\"KuCoin\",\"symbol\":\"BYDUSDTM\",\"company_key\":\"BYD\",\"company_name\":\"比亚迪\",\"layer\":\"已上市公司\",\"status\":\"Open\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"HK.STOCK\",\"source_url\":\"https://api-futures.kucoin.com/api/v1/contracts/active\",\"fetched_at\":\"2026-09-10T08:53:24.574Z\",\"price\":10.126,\"currency\":\"USD / USDT\",\"volume\":2665303.1694,\"oi\":null,\"funding\":0.0001,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":-3.52,\"quoteAt\":\"2026-09-10T08:53:24.574Z\",\"quoteSource\":null},{\"venue\":\"kucoin\",\"venue_name\":\"KuCoin\",\"symbol\":\"GIGADEVUSDTM\",\"company_key\":\"GIGADEV\",\"company_name\":\"兆易创新\",\"layer\":\"已上市公司\",\"status\":\"Open\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"HK.STOCK；GIGADEV/ZHONGJI上市线另有官方公告\",\"source_url\":\"https://api-futures.kucoin.com/api/v1/contracts/active\",\"fetched_at\":\"2026-09-10T08:53:24.574Z\",\"price\":60.93,\"currency\":\"USD / USDT\",\"volume\":591564.0086,\"oi\":null,\"funding\":0.0001,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":-0.89,\"quoteAt\":\"2026-09-10T08:53:24.574Z\",\"quoteSource\":null},{\"venue\":\"kucoin\",\"venue_name\":\"KuCoin\",\"symbol\":\"KUAISHOUUSDTM\",\"company_key\":\"KUAISHOU\",\"company_name\":\"快手科技\",\"layer\":\"已上市公司\",\"status\":\"Open\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"HK.STOCK\",\"source_url\":\"https://api-futures.kucoin.com/api/v1/contracts/active\",\"fetched_at\":\"2026-09-10T08:53:24.574Z\",\"price\":4.038,\"currency\":\"USD / USDT\",\"volume\":2196389.602,\"oi\":null,\"funding\":0.000825,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":-2.41,\"quoteAt\":\"2026-09-10T08:53:24.574Z\",\"quoteSource\":null},{\"venue\":\"kucoin\",\"venue_name\":\"KuCoin\",\"symbol\":\"MEITUANUSDTM\",\"company_key\":\"MEITUAN\",\"company_name\":\"美团\",\"layer\":\"已上市公司\",\"status\":\"Open\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"HK.STOCK\",\"source_url\":\"https://api-futures.kucoin.com/api/v1/contracts/active\",\"fetched_at\":\"2026-09-10T08:53:24.574Z\",\"price\":9.614,\"currency\":\"USD / USDT\",\"volume\":2695372.8786,\"oi\":null,\"funding\":0.001251,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":-3.29,\"quoteAt\":\"2026-09-10T08:53:24.574Z\",\"quoteSource\":null},{\"venue\":\"kucoin\",\"venue_name\":\"KuCoin\",\"symbol\":\"MINIMAXUSDTM\",\"company_key\":\"MINIMAX\",\"company_name\":\"MiniMax（稀宇科技）\",\"layer\":\"已上市公司\",\"status\":\"Open\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"HK.STOCK\",\"source_url\":\"https://api-futures.kucoin.com/api/v1/contracts/active\",\"fetched_at\":\"2026-09-10T08:53:24.574Z\",\"price\":37.28,\"currency\":\"USD / USDT\",\"volume\":744690.868,\"oi\":null,\"funding\":0.000274,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":-9.86,\"quoteAt\":\"2026-09-10T08:53:24.574Z\",\"quoteSource\":null},{\"venue\":\"kucoin\",\"venue_name\":\"KuCoin\",\"symbol\":\"PDDUSDTM\",\"company_key\":\"PDD\",\"company_name\":\"拼多多\",\"layer\":\"美股中概补充\",\"status\":\"Open\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"US.STOCK\",\"source_url\":\"https://api-futures.kucoin.com/api/v1/contracts/active\",\"fetched_at\":\"2026-09-10T08:53:24.574Z\",\"price\":78.8,\"currency\":\"USD / USDT\",\"volume\":2623776.171,\"oi\":null,\"funding\":0.000956,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":-1.73,\"quoteAt\":\"2026-09-10T08:53:24.574Z\",\"quoteSource\":null},{\"venue\":\"kucoin\",\"venue_name\":\"KuCoin\",\"symbol\":\"POPMARTUSDTM\",\"company_key\":\"POPMART\",\"company_name\":\"泡泡玛特\",\"layer\":\"已上市公司\",\"status\":\"Open\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"HK.STOCK\",\"source_url\":\"https://api-futures.kucoin.com/api/v1/contracts/active\",\"fetched_at\":\"2026-09-10T08:53:24.574Z\",\"price\":19.39,\"currency\":\"USD / USDT\",\"volume\":518701.122,\"oi\":null,\"funding\":0.0001,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":-2.6599999999999997,\"quoteAt\":\"2026-09-10T08:53:24.574Z\",\"quoteSource\":null},{\"venue\":\"kucoin\",\"venue_name\":\"KuCoin\",\"symbol\":\"SHEINHKDUSDTM\",\"company_key\":\"SHEIN\",\"company_name\":\"SHEIN（希音）\",\"layer\":\"已上市公司\",\"status\":\"Open\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"HK.STOCK\",\"source_url\":\"https://api-futures.kucoin.com/api/v1/contracts/active\",\"fetched_at\":\"2026-09-10T08:53:24.574Z\",\"price\":41.09,\"currency\":\"HKD 数值 / USDT quanto\",\"volume\":2615720.01,\"oi\":null,\"funding\":0.0001,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":0.83,\"quoteAt\":\"2026-09-10T08:53:24.574Z\",\"quoteSource\":null},{\"venue\":\"kucoin\",\"venue_name\":\"KuCoin\",\"symbol\":\"TENCENTHKDUSDTM\",\"company_key\":\"TENCENT\",\"company_name\":\"腾讯控股\",\"layer\":\"已上市公司\",\"status\":\"Open\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"HK.STOCK\",\"source_url\":\"https://api-futures.kucoin.com/api/v1/contracts/active\",\"fetched_at\":\"2026-09-10T08:53:24.574Z\",\"price\":426.55,\"currency\":\"HKD 数值 / USDT quanto\",\"volume\":1146256.5992,\"oi\":null,\"funding\":0.0001,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":-2.27,\"quoteAt\":\"2026-09-10T08:53:24.574Z\",\"quoteSource\":null},{\"venue\":\"kucoin\",\"venue_name\":\"KuCoin\",\"symbol\":\"TENCENTUSDTM\",\"company_key\":\"TENCENT\",\"company_name\":\"腾讯控股\",\"layer\":\"已上市公司\",\"status\":\"Open\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"HK.STOCK\",\"source_url\":\"https://api-futures.kucoin.com/api/v1/contracts/active\",\"fetched_at\":\"2026-09-10T08:53:24.574Z\",\"price\":54.54,\"currency\":\"USD / USDT\",\"volume\":1483285.776,\"oi\":null,\"funding\":0.0001,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":-1.92,\"quoteAt\":\"2026-09-10T08:53:24.574Z\",\"quoteSource\":null},{\"venue\":\"kucoin\",\"venue_name\":\"KuCoin\",\"symbol\":\"XIAOMIHKDUSDTM\",\"company_key\":\"XIAOMI\",\"company_name\":\"小米集团\",\"layer\":\"已上市公司\",\"status\":\"Open\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"HK.STOCK\",\"source_url\":\"https://api-futures.kucoin.com/api/v1/contracts/active\",\"fetched_at\":\"2026-09-10T08:53:24.574Z\",\"price\":26,\"currency\":\"HKD 数值 / USDT quanto\",\"volume\":1357487.044,\"oi\":null,\"funding\":0.001317,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":-1.16,\"quoteAt\":\"2026-09-10T08:53:24.574Z\",\"quoteSource\":null},{\"venue\":\"kucoin\",\"venue_name\":\"KuCoin\",\"symbol\":\"ZHIPUUSDTM\",\"company_key\":\"ZHIPU\",\"company_name\":\"智谱\",\"layer\":\"已上市公司\",\"status\":\"Open\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"HK.STOCK\",\"source_url\":\"https://api-futures.kucoin.com/api/v1/contracts/active\",\"fetched_at\":\"2026-09-10T08:53:24.574Z\",\"price\":104.6,\"currency\":\"USD / USDT\",\"volume\":1219455.948,\"oi\":null,\"funding\":0.001014,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":-10.75,\"quoteAt\":\"2026-09-10T08:53:24.574Z\",\"quoteSource\":null},{\"venue\":\"kucoin\",\"venue_name\":\"KuCoin\",\"symbol\":\"ZHONGJIUSDTM\",\"company_key\":\"ZHONGJI\",\"company_name\":\"中际旭创\",\"layer\":\"已上市公司\",\"status\":\"Open\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"HK.STOCK；GIGADEV/ZHONGJI上市线另有官方公告\",\"source_url\":\"https://api-futures.kucoin.com/api/v1/contracts/active\",\"fetched_at\":\"2026-09-10T08:53:24.574Z\",\"price\":143.13,\"currency\":\"USD / USDT\",\"volume\":886690.5436,\"oi\":null,\"funding\":5e-05,\"interval\":4,\"nextFunding\":1789041600000,\"bid\":null,\"ask\":null,\"change\":-4.46,\"quoteAt\":\"2026-09-10T08:53:24.574Z\",\"quoteSource\":null}]},{\"venue\":\"okx\",\"name\":\"OKX\",\"observedAt\":\"2026-09-10T08:53:23.997Z\",\"attemptedAt\":\"2026-09-10T08:53:23.997Z\",\"error\":null,\"quoteError\":null,\"rows\":[{\"venue\":\"okx\",\"venue_name\":\"OKX\",\"symbol\":\"CXMT-USDT-SWAP\",\"company_key\":\"CXMT\",\"company_name\":\"长鑫存储\",\"layer\":\"已上市公司\",\"status\":\"live\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://www.okx.com/api/v5/public/instruments?instType=SWAP\",\"fetched_at\":\"2026-09-10T08:53:23.997Z\",\"price\":8.393,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":8.392,\"ask\":8.394,\"change\":null,\"quoteAt\":\"2026-09-10T08:53:23.997Z\",\"quoteSource\":null},{\"venue\":\"okx\",\"venue_name\":\"OKX\",\"symbol\":\"MINIMAX-USDT-SWAP\",\"company_key\":\"MINIMAX\",\"company_name\":\"MiniMax（稀宇科技）\",\"layer\":\"已上市公司\",\"status\":\"live\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://www.okx.com/api/v5/public/instruments?instType=SWAP\",\"fetched_at\":\"2026-09-10T08:53:23.997Z\",\"price\":37.31,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":37.32,\"ask\":37.35,\"change\":null,\"quoteAt\":\"2026-09-10T08:53:23.997Z\",\"quoteSource\":null},{\"venue\":\"okx\",\"venue_name\":\"OKX\",\"symbol\":\"MOONSHOT-USDT-SWAP\",\"company_key\":\"KIMI\",\"company_name\":\"月之暗面 / Kimi\",\"layer\":\"预上市补充\",\"status\":\"live\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"预上市价格预期；不等同于上市后股价\",\"source_url\":\"https://www.okx.com/api/v5/public/instruments?instType=SWAP\",\"fetched_at\":\"2026-09-10T08:53:23.997Z\",\"price\":72.63,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":72.63,\"ask\":72.66,\"change\":null,\"quoteAt\":\"2026-09-10T08:53:23.997Z\",\"quoteSource\":null},{\"venue\":\"okx\",\"venue_name\":\"OKX\",\"symbol\":\"POPMART-USDT-SWAP\",\"company_key\":\"POPMART\",\"company_name\":\"泡泡玛特\",\"layer\":\"已上市公司\",\"status\":\"live\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://www.okx.com/api/v5/public/instruments?instType=SWAP\",\"fetched_at\":\"2026-09-10T08:53:23.997Z\",\"price\":19.38,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":19.38,\"ask\":19.39,\"change\":null,\"quoteAt\":\"2026-09-10T08:53:23.997Z\",\"quoteSource\":null},{\"venue\":\"okx\",\"venue_name\":\"OKX\",\"symbol\":\"SHEIN-USDT-SWAP\",\"company_key\":\"SHEIN\",\"company_name\":\"SHEIN（希音）\",\"layer\":\"已上市公司\",\"status\":\"live\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://www.okx.com/api/v5/public/instruments?instType=SWAP\",\"fetched_at\":\"2026-09-10T08:53:23.997Z\",\"price\":5.23,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":5.23,\"ask\":5.25,\"change\":null,\"quoteAt\":\"2026-09-10T08:53:23.997Z\",\"quoteSource\":null},{\"venue\":\"okx\",\"venue_name\":\"OKX\",\"symbol\":\"UNITREE-USDT-SWAP\",\"company_key\":\"UNITREE\",\"company_name\":\"宇树科技\",\"layer\":\"已上市公司\",\"status\":\"live\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://www.okx.com/api/v5/public/instruments?instType=SWAP\",\"fetched_at\":\"2026-09-10T08:53:23.997Z\",\"price\":74.08,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":74.09,\"ask\":74.1,\"change\":null,\"quoteAt\":\"2026-09-10T08:53:23.997Z\",\"quoteSource\":null},{\"venue\":\"okx\",\"venue_name\":\"OKX\",\"symbol\":\"XIAOMI-USDT-SWAP\",\"company_key\":\"XIAOMI\",\"company_name\":\"小米集团\",\"layer\":\"已上市公司\",\"status\":\"live\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://www.okx.com/api/v5/public/instruments?instType=SWAP\",\"fetched_at\":\"2026-09-10T08:53:23.997Z\",\"price\":3.315,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":3.315,\"ask\":3.317,\"change\":null,\"quoteAt\":\"2026-09-10T08:53:23.997Z\",\"quoteSource\":null},{\"venue\":\"okx\",\"venue_name\":\"OKX\",\"symbol\":\"ZHIPU-USDT-SWAP\",\"company_key\":\"ZHIPU\",\"company_name\":\"智谱\",\"layer\":\"已上市公司\",\"status\":\"live\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://www.okx.com/api/v5/public/instruments?instType=SWAP\",\"fetched_at\":\"2026-09-10T08:53:23.997Z\",\"price\":104.63,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":104.59,\"ask\":104.63,\"change\":null,\"quoteAt\":\"2026-09-10T08:53:23.997Z\",\"quoteSource\":null},{\"venue\":\"okx\",\"venue_name\":\"OKX\",\"symbol\":\"ZHONGJI-USDT-SWAP\",\"company_key\":\"ZHONGJI\",\"company_name\":\"中际旭创\",\"layer\":\"已上市公司\",\"status\":\"live\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://www.okx.com/api/v5/public/instruments?instType=SWAP\",\"fetched_at\":\"2026-09-10T08:53:23.997Z\",\"price\":143.18,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":143.12,\"ask\":143.21,\"change\":null,\"quoteAt\":\"2026-09-10T08:53:23.997Z\",\"quoteSource\":null}]},{\"venue\":\"htx\",\"name\":\"HTX\",\"observedAt\":\"2026-09-10T08:53:22.894Z\",\"attemptedAt\":\"2026-09-10T08:53:22.894Z\",\"error\":null,\"quoteError\":null,\"rows\":[{\"venue\":\"htx\",\"venue_name\":\"HTX\",\"symbol\":\"BYD-USDT\",\"company_key\":\"BYD\",\"company_name\":\"比亚迪\",\"layer\":\"已上市公司\",\"status\":1,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.hbdm.com/linear-swap-api/v1/swap_contract_info\",\"fetched_at\":\"2026-09-10T08:53:22.894Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"htx\",\"venue_name\":\"HTX\",\"symbol\":\"POPMART-USDT\",\"company_key\":\"POPMART\",\"company_name\":\"泡泡玛特\",\"layer\":\"已上市公司\",\"status\":1,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.hbdm.com/linear-swap-api/v1/swap_contract_info\",\"fetched_at\":\"2026-09-10T08:53:22.894Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"htx\",\"venue_name\":\"HTX\",\"symbol\":\"PDD-USDT\",\"company_key\":\"PDD\",\"company_name\":\"拼多多\",\"layer\":\"美股中概补充\",\"status\":1,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.hbdm.com/linear-swap-api/v1/swap_contract_info\",\"fetched_at\":\"2026-09-10T08:53:22.894Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"htx\",\"venue_name\":\"HTX\",\"symbol\":\"HK0625-USDT\",\"company_key\":\"SHEIN\",\"company_name\":\"SHEIN（希音）\",\"layer\":\"已上市公司\",\"status\":1,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.hbdm.com/linear-swap-api/v1/swap_contract_info\",\"fetched_at\":\"2026-09-10T08:53:22.894Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"htx\",\"venue_name\":\"HTX\",\"symbol\":\"ZHIPU-USDT\",\"company_key\":\"ZHIPU\",\"company_name\":\"智谱\",\"layer\":\"已上市公司\",\"status\":1,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.hbdm.com/linear-swap-api/v1/swap_contract_info\",\"fetched_at\":\"2026-09-10T08:53:22.894Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"htx\",\"venue_name\":\"HTX\",\"symbol\":\"JD-USDT\",\"company_key\":\"JD\",\"company_name\":\"京东\",\"layer\":\"美股中概补充\",\"status\":1,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.hbdm.com/linear-swap-api/v1/swap_contract_info\",\"fetched_at\":\"2026-09-10T08:53:22.894Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"htx\",\"venue_name\":\"HTX\",\"symbol\":\"TENCENT-USDT\",\"company_key\":\"TENCENT\",\"company_name\":\"腾讯控股\",\"layer\":\"已上市公司\",\"status\":1,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.hbdm.com/linear-swap-api/v1/swap_contract_info\",\"fetched_at\":\"2026-09-10T08:53:22.894Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"htx\",\"venue_name\":\"HTX\",\"symbol\":\"KUAISHOU-USDT\",\"company_key\":\"KUAISHOU\",\"company_name\":\"快手科技\",\"layer\":\"已上市公司\",\"status\":1,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.hbdm.com/linear-swap-api/v1/swap_contract_info\",\"fetched_at\":\"2026-09-10T08:53:22.894Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"htx\",\"venue_name\":\"HTX\",\"symbol\":\"HK0700-USDT\",\"company_key\":\"TENCENT\",\"company_name\":\"腾讯控股\",\"layer\":\"已上市公司\",\"status\":1,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.hbdm.com/linear-swap-api/v1/swap_contract_info\",\"fetched_at\":\"2026-09-10T08:53:22.894Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"htx\",\"venue_name\":\"HTX\",\"symbol\":\"MINIMAX-USDT\",\"company_key\":\"MINIMAX\",\"company_name\":\"MiniMax（稀宇科技）\",\"layer\":\"已上市公司\",\"status\":1,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.hbdm.com/linear-swap-api/v1/swap_contract_info\",\"fetched_at\":\"2026-09-10T08:53:22.894Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"htx\",\"venue_name\":\"HTX\",\"symbol\":\"SMIC-USDT\",\"company_key\":\"SMIC\",\"company_name\":\"中芯国际\",\"layer\":\"已上市公司\",\"status\":1,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.hbdm.com/linear-swap-api/v1/swap_contract_info\",\"fetched_at\":\"2026-09-10T08:53:22.894Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"htx\",\"venue_name\":\"HTX\",\"symbol\":\"CXMT-USDT\",\"company_key\":\"CXMT\",\"company_name\":\"长鑫存储\",\"layer\":\"已上市公司\",\"status\":1,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.hbdm.com/linear-swap-api/v1/swap_contract_info\",\"fetched_at\":\"2026-09-10T08:53:22.894Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"htx\",\"venue_name\":\"HTX\",\"symbol\":\"HK1810-USDT\",\"company_key\":\"XIAOMI\",\"company_name\":\"小米集团\",\"layer\":\"已上市公司\",\"status\":1,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.hbdm.com/linear-swap-api/v1/swap_contract_info\",\"fetched_at\":\"2026-09-10T08:53:22.894Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"htx\",\"venue_name\":\"HTX\",\"symbol\":\"MEITUAN-USDT\",\"company_key\":\"MEITUAN\",\"company_name\":\"美团\",\"layer\":\"已上市公司\",\"status\":1,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.hbdm.com/linear-swap-api/v1/swap_contract_info\",\"fetched_at\":\"2026-09-10T08:53:22.894Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"htx\",\"venue_name\":\"HTX\",\"symbol\":\"ZHONGJI-USDT\",\"company_key\":\"ZHONGJI\",\"company_name\":\"中际旭创\",\"layer\":\"已上市公司\",\"status\":1,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.hbdm.com/linear-swap-api/v1/swap_contract_info\",\"fetched_at\":\"2026-09-10T08:53:22.894Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"htx\",\"venue_name\":\"HTX\",\"symbol\":\"SHEIN-USDT\",\"company_key\":\"SHEIN\",\"company_name\":\"SHEIN（希音）\",\"layer\":\"已上市公司\",\"status\":1,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.hbdm.com/linear-swap-api/v1/swap_contract_info\",\"fetched_at\":\"2026-09-10T08:53:22.894Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"htx\",\"venue_name\":\"HTX\",\"symbol\":\"UNITREE-USDT\",\"company_key\":\"UNITREE\",\"company_name\":\"宇树科技\",\"layer\":\"已上市公司\",\"status\":1,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.hbdm.com/linear-swap-api/v1/swap_contract_info\",\"fetched_at\":\"2026-09-10T08:53:22.894Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"htx\",\"venue_name\":\"HTX\",\"symbol\":\"GIGADEV-USDT\",\"company_key\":\"GIGADEV\",\"company_name\":\"兆易创新\",\"layer\":\"已上市公司\",\"status\":1,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.hbdm.com/linear-swap-api/v1/swap_contract_info\",\"fetched_at\":\"2026-09-10T08:53:22.894Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"htx\",\"venue_name\":\"HTX\",\"symbol\":\"BABA-USDT\",\"company_key\":\"BABA\",\"company_name\":\"阿里巴巴\",\"layer\":\"美股中概补充\",\"status\":1,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.hbdm.com/linear-swap-api/v1/swap_contract_info\",\"fetched_at\":\"2026-09-10T08:53:22.894Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null}]},{\"venue\":\"xt\",\"name\":\"XT\",\"observedAt\":\"2026-09-10T08:53:24.641Z\",\"attemptedAt\":\"2026-09-10T08:53:24.641Z\",\"error\":null,\"quoteError\":null,\"rows\":[{\"venue\":\"xt\",\"venue_name\":\"XT\",\"symbol\":\"minimax_usdt\",\"company_key\":\"MINIMAX\",\"company_name\":\"MiniMax（稀宇科技）\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://fapi.xt.com/future/market/v1/public/symbol/list\",\"fetched_at\":\"2026-09-10T08:53:24.641Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"xt\",\"venue_name\":\"XT\",\"symbol\":\"zhipu_usdt\",\"company_key\":\"ZHIPU\",\"company_name\":\"智谱\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://fapi.xt.com/future/market/v1/public/symbol/list\",\"fetched_at\":\"2026-09-10T08:53:24.641Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"xt\",\"venue_name\":\"XT\",\"symbol\":\"tencent_usdt\",\"company_key\":\"TENCENT\",\"company_name\":\"腾讯控股\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://fapi.xt.com/future/market/v1/public/symbol/list\",\"fetched_at\":\"2026-09-10T08:53:24.641Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"xt\",\"venue_name\":\"XT\",\"symbol\":\"popmart_usdt\",\"company_key\":\"POPMART\",\"company_name\":\"泡泡玛特\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://fapi.xt.com/future/market/v1/public/symbol/list\",\"fetched_at\":\"2026-09-10T08:53:24.641Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"xt\",\"venue_name\":\"XT\",\"symbol\":\"gigadev_usdt\",\"company_key\":\"GIGADEV\",\"company_name\":\"兆易创新\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://fapi.xt.com/future/market/v1/public/symbol/list\",\"fetched_at\":\"2026-09-10T08:53:24.641Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"xt\",\"venue_name\":\"XT\",\"symbol\":\"kuaishou_usdt\",\"company_key\":\"KUAISHOU\",\"company_name\":\"快手科技\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://fapi.xt.com/future/market/v1/public/symbol/list\",\"fetched_at\":\"2026-09-10T08:53:24.641Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"xt\",\"venue_name\":\"XT\",\"symbol\":\"meituan_usdt\",\"company_key\":\"MEITUAN\",\"company_name\":\"美团\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://fapi.xt.com/future/market/v1/public/symbol/list\",\"fetched_at\":\"2026-09-10T08:53:24.641Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"xt\",\"venue_name\":\"XT\",\"symbol\":\"zhongji_usdt\",\"company_key\":\"ZHONGJI\",\"company_name\":\"中际旭创\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://fapi.xt.com/future/market/v1/public/symbol/list\",\"fetched_at\":\"2026-09-10T08:53:24.641Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"xt\",\"venue_name\":\"XT\",\"symbol\":\"cxmt_usdt\",\"company_key\":\"CXMT\",\"company_name\":\"长鑫存储\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://fapi.xt.com/future/market/v1/public/symbol/list\",\"fetched_at\":\"2026-09-10T08:53:24.641Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"xt\",\"venue_name\":\"XT\",\"symbol\":\"unitree_usdt\",\"company_key\":\"UNITREE\",\"company_name\":\"宇树科技\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://fapi.xt.com/future/market/v1/public/symbol/list\",\"fetched_at\":\"2026-09-10T08:53:24.641Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"xt\",\"venue_name\":\"XT\",\"symbol\":\"pdd_usdt\",\"company_key\":\"PDD\",\"company_name\":\"拼多多\",\"layer\":\"美股中概补充\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://fapi.xt.com/future/market/v1/public/symbol/list\",\"fetched_at\":\"2026-09-10T08:53:24.641Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"xt\",\"venue_name\":\"XT\",\"symbol\":\"byd_usdt\",\"company_key\":\"BYD\",\"company_name\":\"比亚迪\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://fapi.xt.com/future/market/v1/public/symbol/list\",\"fetched_at\":\"2026-09-10T08:53:24.641Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"xt\",\"venue_name\":\"XT\",\"symbol\":\"shein_usdt\",\"company_key\":\"SHEIN\",\"company_name\":\"SHEIN（希音）\",\"layer\":\"已上市公司\",\"status\":0,\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://fapi.xt.com/future/market/v1/public/symbol/list\",\"fetched_at\":\"2026-09-10T08:53:24.641Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null}]},{\"venue\":\"aster\",\"name\":\"Aster\",\"observedAt\":\"2026-09-10T08:53:29.200Z\",\"attemptedAt\":\"2026-09-10T08:53:29.200Z\",\"error\":null,\"quoteError\":null,\"rows\":[{\"venue\":\"aster\",\"venue_name\":\"Aster\",\"symbol\":\"PDDUSDT\",\"company_key\":\"PDD\",\"company_name\":\"拼多多\",\"layer\":\"美股中概补充\",\"status\":\"SETTLING\",\"directory_open\":false,\"caution\":\"\",\"reason\":\"暂停 / 下架\",\"anchor\":\"nasdaq；['拼多多', '股票']\",\"source_url\":\"https://fapi.asterdex.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:29.200Z\",\"price\":78.63911427,\"currency\":\"USD / USDT\",\"volume\":858.4,\"oi\":null,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":0,\"quoteAt\":\"2026-09-10T08:53:29.200Z\",\"quoteSource\":null},{\"venue\":\"aster\",\"venue_name\":\"Aster\",\"symbol\":\"BABAUSDT\",\"company_key\":\"BABA\",\"company_name\":\"阿里巴巴\",\"layer\":\"美股中概补充\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"nasdaq；['阿里巴巴', '股票']\",\"source_url\":\"https://fapi.asterdex.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:29.200Z\",\"price\":109.12007072,\"currency\":\"USD / USDT\",\"volume\":20363.48,\"oi\":null,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":-2.732,\"quoteAt\":\"2026-09-10T08:53:29.200Z\",\"quoteSource\":null},{\"venue\":\"aster\",\"venue_name\":\"Aster\",\"symbol\":\"POPMARTUSDT\",\"company_key\":\"POPMART\",\"company_name\":\"泡泡玛特\",\"layer\":\"已上市公司\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"hkstock；['9992', '泡泡玛特', '泡泡瑪特', 'Hong Kong stocks', '港股']\",\"source_url\":\"https://fapi.asterdex.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:29.200Z\",\"price\":19.42157191,\"currency\":\"USD / USDT\",\"volume\":3445.81,\"oi\":null,\"funding\":0.00038199,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":-0.102,\"quoteAt\":\"2026-09-10T08:53:29.200Z\",\"quoteSource\":null},{\"venue\":\"aster\",\"venue_name\":\"Aster\",\"symbol\":\"XIAOMIUSDT\",\"company_key\":\"XIAOMI\",\"company_name\":\"小米集团\",\"layer\":\"已上市公司\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"hkstock；['1810', '小米', 'Hong Kong stocks', '港股']\",\"source_url\":\"https://fapi.asterdex.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:29.200Z\",\"price\":3.36278333,\"currency\":\"USD / USDT\",\"volume\":4329.94,\"oi\":null,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":-0.824,\"quoteAt\":\"2026-09-10T08:53:29.200Z\",\"quoteSource\":null},{\"venue\":\"aster\",\"venue_name\":\"Aster\",\"symbol\":\"MINIMAXUSDT\",\"company_key\":\"MINIMAX\",\"company_name\":\"MiniMax（稀宇科技）\",\"layer\":\"已上市公司\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"hkstock；['0100', '稀宇科技', 'Hong Kong stocks', '港股']\",\"source_url\":\"https://fapi.asterdex.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:29.200Z\",\"price\":37.36584454,\"currency\":\"USD / USDT\",\"volume\":70829.6,\"oi\":null,\"funding\":0.00028688,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":-8.486,\"quoteAt\":\"2026-09-10T08:53:29.200Z\",\"quoteSource\":null},{\"venue\":\"aster\",\"venue_name\":\"Aster\",\"symbol\":\"TENCENTUSDT\",\"company_key\":\"TENCENT\",\"company_name\":\"腾讯控股\",\"layer\":\"已上市公司\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"hkstock；['0700', '腾讯', '騰訊', 'Hong Kong stocks', '港股']\",\"source_url\":\"https://fapi.asterdex.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:29.200Z\",\"price\":54.59873487,\"currency\":\"USD / USDT\",\"volume\":1629.75,\"oi\":null,\"funding\":0.000301,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":-1.675,\"quoteAt\":\"2026-09-10T08:53:29.200Z\",\"quoteSource\":null},{\"venue\":\"aster\",\"venue_name\":\"Aster\",\"symbol\":\"FUTUUSDT\",\"company_key\":\"FUTU\",\"company_name\":\"富途控股\",\"layer\":\"美股中概补充\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"nasdaq；[]\",\"source_url\":\"https://fapi.asterdex.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:29.200Z\",\"price\":116.85356114,\"currency\":\"USD / USDT\",\"volume\":51162.63,\"oi\":null,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":-1.25,\"quoteAt\":\"2026-09-10T08:53:29.200Z\",\"quoteSource\":null},{\"venue\":\"aster\",\"venue_name\":\"Aster\",\"symbol\":\"ZHIPUUSDT\",\"company_key\":\"ZHIPU\",\"company_name\":\"智谱\",\"layer\":\"已上市公司\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"hkstock；['Knowledge Atlas Tech']\",\"source_url\":\"https://fapi.asterdex.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:29.200Z\",\"price\":104.51314247,\"currency\":\"USD / USDT\",\"volume\":70764.18,\"oi\":null,\"funding\":0.0007231,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":-10.336,\"quoteAt\":\"2026-09-10T08:53:29.200Z\",\"quoteSource\":null},{\"venue\":\"aster\",\"venue_name\":\"Aster\",\"symbol\":\"CXMTUSDT\",\"company_key\":\"CXMT\",\"company_name\":\"长鑫存储\",\"layer\":\"已上市公司\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"astock；['ChangXin Technology', '长鑫科技', '股票', '長鑫科技', '股票']\",\"source_url\":\"https://fapi.asterdex.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:29.200Z\",\"price\":8.39513133,\"currency\":\"USD / USDT\",\"volume\":154566.28,\"oi\":null,\"funding\":-0.00424081,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":0.671,\"quoteAt\":\"2026-09-10T08:53:29.200Z\",\"quoteSource\":null},{\"venue\":\"aster\",\"venue_name\":\"Aster\",\"symbol\":\"UNITREEUSDT\",\"company_key\":\"UNITREE\",\"company_name\":\"宇树科技\",\"layer\":\"已上市公司\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"astock；['Unitree Robotics', '宇树科技', '股票', '宇樹科技']\",\"source_url\":\"https://fapi.asterdex.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:29.200Z\",\"price\":74.24076929,\"currency\":\"USD / USDT\",\"volume\":119553.36,\"oi\":null,\"funding\":-1.9e-06,\"interval\":4,\"nextFunding\":1789041600000,\"bid\":null,\"ask\":null,\"change\":-3.578,\"quoteAt\":\"2026-09-10T08:53:29.200Z\",\"quoteSource\":null},{\"venue\":\"aster\",\"venue_name\":\"Aster\",\"symbol\":\"MEITUANUSDT\",\"company_key\":\"MEITUAN\",\"company_name\":\"美团\",\"layer\":\"已上市公司\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"hkstock；['Meituan', '美团']\",\"source_url\":\"https://fapi.asterdex.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:29.200Z\",\"price\":9.59490326,\"currency\":\"USD / USDT\",\"volume\":5270.65,\"oi\":null,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":-4.217,\"quoteAt\":\"2026-09-10T08:53:29.200Z\",\"quoteSource\":null},{\"venue\":\"aster\",\"venue_name\":\"Aster\",\"symbol\":\"KUAISHOUUSDT\",\"company_key\":\"KUAISHOU\",\"company_name\":\"快手科技\",\"layer\":\"已上市公司\",\"status\":\"TRADING\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"hkstock；['KuaiShou', '快手']\",\"source_url\":\"https://fapi.asterdex.com/fapi/v1/exchangeInfo\",\"fetched_at\":\"2026-09-10T08:53:29.200Z\",\"price\":4.04196818,\"currency\":\"USD / USDT\",\"volume\":17209.47,\"oi\":null,\"funding\":0,\"interval\":8,\"nextFunding\":1789056000000,\"bid\":null,\"ask\":null,\"change\":-1.964,\"quoteAt\":\"2026-09-10T08:53:29.200Z\",\"quoteSource\":null}]},{\"venue\":\"hyperliquid_xyz\",\"name\":\"Hyperliquid XYZ\",\"observedAt\":\"2026-09-10T08:53:25.703Z\",\"attemptedAt\":\"2026-09-10T08:53:25.703Z\",\"error\":null,\"quoteError\":null,\"rows\":[{\"venue\":\"hyperliquid_xyz\",\"venue_name\":\"Hyperliquid XYZ\",\"symbol\":\"xyz:BABA\",\"company_key\":\"BABA\",\"company_name\":\"阿里巴巴\",\"layer\":\"美股中概补充\",\"status\":\"active\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://api.hyperliquid.xyz/info\",\"fetched_at\":\"2026-09-10T08:53:25.703Z\",\"price\":109.06,\"currency\":\"USD / USDT\",\"volume\":2983620.9166400004,\"oi\":12151017.617759999,\"funding\":6.25e-06,\"interval\":1,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":-2.807236431690574,\"quoteAt\":\"2026-09-10T08:53:25.703Z\",\"quoteSource\":null},{\"venue\":\"hyperliquid_xyz\",\"venue_name\":\"Hyperliquid XYZ\",\"symbol\":\"xyz:MINIMAX\",\"company_key\":\"MINIMAX\",\"company_name\":\"MiniMax（稀宇科技）\",\"layer\":\"已上市公司\",\"status\":\"active\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"官方XYZ规格：0100.HK\",\"source_url\":\"https://api.hyperliquid.xyz/info\",\"fetched_at\":\"2026-09-10T08:53:25.703Z\",\"price\":37.301,\"currency\":\"USD / USDT\",\"volume\":3931222.6941299983,\"oi\":11866147.12074,\"funding\":3.33627e-05,\"interval\":1,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":-9.709043377226944,\"quoteAt\":\"2026-09-10T08:53:25.703Z\",\"quoteSource\":null},{\"venue\":\"hyperliquid_xyz\",\"venue_name\":\"Hyperliquid XYZ\",\"symbol\":\"xyz:ZHIPU\",\"company_key\":\"ZHIPU\",\"company_name\":\"智谱\",\"layer\":\"已上市公司\",\"status\":\"active\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"官方XYZ规格：2513.HK\",\"source_url\":\"https://api.hyperliquid.xyz/info\",\"fetched_at\":\"2026-09-10T08:53:25.703Z\",\"price\":104.48,\"currency\":\"USD / USDT\",\"volume\":7284026.668999999,\"oi\":10747600.370240001,\"funding\":0.0001308672,\"interval\":1,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":-10.860848050507633,\"quoteAt\":\"2026-09-10T08:53:25.703Z\",\"quoteSource\":null},{\"venue\":\"hyperliquid_xyz\",\"venue_name\":\"Hyperliquid XYZ\",\"symbol\":\"xyz:GIGADEV\",\"company_key\":\"GIGADEV\",\"company_name\":\"兆易创新\",\"layer\":\"已上市公司\",\"status\":\"active\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"官方XYZ规格：A 603986.SH\",\"source_url\":\"https://api.hyperliquid.xyz/info\",\"fetched_at\":\"2026-09-10T08:53:25.703Z\",\"price\":56.435,\"currency\":\"USD / USDT\",\"volume\":289815.6116300001,\"oi\":1067632.8151999998,\"funding\":-0.0001503359,\"interval\":1,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":-0.5357866723065152,\"quoteAt\":\"2026-09-10T08:53:25.703Z\",\"quoteSource\":null},{\"venue\":\"hyperliquid_xyz\",\"venue_name\":\"Hyperliquid XYZ\",\"symbol\":\"xyz:CXMT\",\"company_key\":\"CXMT\",\"company_name\":\"长鑫存储\",\"layer\":\"已上市公司\",\"status\":\"active\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"官方XYZ规格：688825.SH\",\"source_url\":\"https://api.hyperliquid.xyz/info\",\"fetched_at\":\"2026-09-10T08:53:25.703Z\",\"price\":8.3876,\"currency\":\"USD / USDT\",\"volume\":9987016.677529998,\"oi\":56119061.26424001,\"funding\":-0.0001984038,\"interval\":1,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":0.4611275466816833,\"quoteAt\":\"2026-09-10T08:53:25.703Z\",\"quoteSource\":null},{\"venue\":\"hyperliquid_xyz\",\"venue_name\":\"Hyperliquid XYZ\",\"symbol\":\"xyz:UNITREE\",\"company_key\":\"UNITREE\",\"company_name\":\"宇树科技\",\"layer\":\"已上市公司\",\"status\":\"active\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"官方XYZ规格：688836.SH\",\"source_url\":\"https://api.hyperliquid.xyz/info\",\"fetched_at\":\"2026-09-10T08:53:25.703Z\",\"price\":74.144,\"currency\":\"USD / USDT\",\"volume\":7036625.436790001,\"oi\":14800238.24832,\"funding\":-4.86559e-05,\"interval\":1,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":-3.5688273852876873,\"quoteAt\":\"2026-09-10T08:53:25.703Z\",\"quoteSource\":null},{\"venue\":\"hyperliquid_xyz\",\"venue_name\":\"Hyperliquid XYZ\",\"symbol\":\"xyz:SHEIN\",\"company_key\":\"SHEIN\",\"company_name\":\"SHEIN（希音）\",\"layer\":\"已上市公司\",\"status\":\"active\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"官方XYZ规格：0625.HK\",\"source_url\":\"https://api.hyperliquid.xyz/info\",\"fetched_at\":\"2026-09-10T08:53:25.703Z\",\"price\":5.2319,\"currency\":\"USD / USDT\",\"volume\":386902.1822600003,\"oi\":883884.51066,\"funding\":-0.0001887274,\"interval\":1,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":1.0292357007685604,\"quoteAt\":\"2026-09-10T08:53:25.703Z\",\"quoteSource\":null},{\"venue\":\"hyperliquid_xyz\",\"venue_name\":\"Hyperliquid XYZ\",\"symbol\":\"xyz:YMTC\",\"company_key\":\"YMTC\",\"company_name\":\"长江存储\",\"layer\":\"预上市补充\",\"status\":\"delisted\",\"directory_open\":false,\"caution\":\"\",\"reason\":\"暂停 / 下架\",\"anchor\":\"预上市价格预期；不等同于上市后股价\",\"source_url\":\"https://api.hyperliquid.xyz/info\",\"fetched_at\":\"2026-09-10T08:53:25.703Z\",\"price\":10,\"currency\":\"USD / USDT\",\"volume\":0,\"oi\":0,\"funding\":0,\"interval\":1,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":0,\"quoteAt\":\"2026-09-10T08:53:25.703Z\",\"quoteSource\":null}]},{\"venue\":\"lighter\",\"name\":\"Lighter\",\"observedAt\":\"2026-09-10T08:53:26.032Z\",\"attemptedAt\":\"2026-09-10T08:53:26.032Z\",\"error\":null,\"quoteError\":null,\"rows\":[{\"venue\":\"lighter\",\"venue_name\":\"Lighter\",\"symbol\":\"TENCENT\",\"company_key\":\"TENCENT\",\"company_name\":\"腾讯控股\",\"layer\":\"已上市公司\",\"status\":\"active\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"官方Lighter规格：0700.HK\",\"source_url\":\"https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails\",\"fetched_at\":\"2026-09-10T08:53:26.032Z\",\"price\":54.82,\"currency\":\"USD / USDT\",\"volume\":8576.316847,\"oi\":null,\"funding\":3.2e-05,\"interval\":8,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":-2.826195219123506,\"quoteAt\":\"2026-09-10T08:53:26.032Z\",\"quoteSource\":null,\"fundingBasis\":\"8h 等效 / 每小时结算\"},{\"venue\":\"lighter\",\"venue_name\":\"Lighter\",\"symbol\":\"BABA\",\"company_key\":\"BABA\",\"company_name\":\"阿里巴巴\",\"layer\":\"美股中概补充\",\"status\":\"active\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"未逐合约披露/核验上市线；勿据同名 ticker 推断\",\"source_url\":\"https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails\",\"fetched_at\":\"2026-09-10T08:53:26.032Z\",\"price\":109.33,\"currency\":\"USD / USDT\",\"volume\":50773.13567,\"oi\":null,\"funding\":3.2e-05,\"interval\":8,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":-2.3633282796753767,\"quoteAt\":\"2026-09-10T08:53:26.032Z\",\"quoteSource\":null,\"fundingBasis\":\"8h 等效 / 每小时结算\"},{\"venue\":\"lighter\",\"venue_name\":\"Lighter\",\"symbol\":\"BYD\",\"company_key\":\"BYD\",\"company_name\":\"比亚迪\",\"layer\":\"已上市公司\",\"status\":\"active\",\"directory_open\":false,\"caution\":\"\",\"reason\":\"只可减仓\",\"anchor\":\"规格名称BYD Company与Pyth链接0285.HK冲突；且已只可减仓\",\"source_url\":\"https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails\",\"fetched_at\":\"2026-09-10T08:53:26.032Z\",\"price\":3.0646,\"currency\":\"USD / USDT\",\"volume\":0,\"oi\":null,\"funding\":3.2e-05,\"interval\":8,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":0,\"quoteAt\":\"2026-09-10T08:53:26.032Z\",\"quoteSource\":null,\"fundingBasis\":\"8h 等效 / 每小时结算\"},{\"venue\":\"lighter\",\"venue_name\":\"Lighter\",\"symbol\":\"ZHIPU\",\"company_key\":\"ZHIPU\",\"company_name\":\"智谱\",\"layer\":\"已上市公司\",\"status\":\"active\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"官方Lighter规格：2513.HK\",\"source_url\":\"https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails\",\"fetched_at\":\"2026-09-10T08:53:26.032Z\",\"price\":104.52,\"currency\":\"USD / USDT\",\"volume\":40863.779262,\"oi\":null,\"funding\":3.2e-05,\"interval\":8,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":-9.139414802065405,\"quoteAt\":\"2026-09-10T08:53:26.032Z\",\"quoteSource\":null,\"fundingBasis\":\"8h 等效 / 每小时结算\"},{\"venue\":\"lighter\",\"venue_name\":\"Lighter\",\"symbol\":\"SMIC\",\"company_key\":\"SMIC\",\"company_name\":\"中芯国际\",\"layer\":\"已上市公司\",\"status\":\"active\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"官方Lighter规格：0981.HK\",\"source_url\":\"https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails\",\"fetched_at\":\"2026-09-10T08:53:26.032Z\",\"price\":8.1043,\"currency\":\"USD / USDT\",\"volume\":32768.823347,\"oi\":null,\"funding\":3.2e-05,\"interval\":8,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":-2.2746998408795025,\"quoteAt\":\"2026-09-10T08:53:26.032Z\",\"quoteSource\":null,\"fundingBasis\":\"8h 等效 / 每小时结算\"},{\"venue\":\"lighter\",\"venue_name\":\"Lighter\",\"symbol\":\"CXMT\",\"company_key\":\"CXMT\",\"company_name\":\"长鑫存储\",\"layer\":\"已上市公司\",\"status\":\"active\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"官方Lighter规格：688825.SH\",\"source_url\":\"https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails\",\"fetched_at\":\"2026-09-10T08:53:26.032Z\",\"price\":8.386,\"currency\":\"USD / USDT\",\"volume\":176579.738353,\"oi\":null,\"funding\":-0.0008719999999999999,\"interval\":8,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":0.9014755795200154,\"quoteAt\":\"2026-09-10T08:53:26.032Z\",\"quoteSource\":null,\"fundingBasis\":\"8h 等效 / 每小时结算\"},{\"venue\":\"lighter\",\"venue_name\":\"Lighter\",\"symbol\":\"POPMART\",\"company_key\":\"POPMART\",\"company_name\":\"泡泡玛特\",\"layer\":\"已上市公司\",\"status\":\"active\",\"directory_open\":false,\"caution\":\"\",\"reason\":\"只可减仓\",\"anchor\":\"官方Lighter规格：9992.HK\",\"source_url\":\"https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails\",\"fetched_at\":\"2026-09-10T08:53:26.032Z\",\"price\":19.455,\"currency\":\"USD / USDT\",\"volume\":0,\"oi\":null,\"funding\":3.2e-05,\"interval\":8,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":0,\"quoteAt\":\"2026-09-10T08:53:26.032Z\",\"quoteSource\":null,\"fundingBasis\":\"8h 等效 / 每小时结算\"},{\"venue\":\"lighter\",\"venue_name\":\"Lighter\",\"symbol\":\"XIAOMI\",\"company_key\":\"XIAOMI\",\"company_name\":\"小米集团\",\"layer\":\"已上市公司\",\"status\":\"active\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"官方Lighter规格：1810.HK\",\"source_url\":\"https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails\",\"fetched_at\":\"2026-09-10T08:53:26.032Z\",\"price\":3.3149,\"currency\":\"USD / USDT\",\"volume\":100.835244,\"oi\":null,\"funding\":3.2e-05,\"interval\":8,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":-1.8451699961864532,\"quoteAt\":\"2026-09-10T08:53:26.032Z\",\"quoteSource\":null,\"fundingBasis\":\"8h 等效 / 每小时结算\"},{\"venue\":\"lighter\",\"venue_name\":\"Lighter\",\"symbol\":\"SHEIN\",\"company_key\":\"SHEIN\",\"company_name\":\"SHEIN（希音）\",\"layer\":\"已上市公司\",\"status\":\"active\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"官方Lighter规格：0625.HK\",\"source_url\":\"https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails\",\"fetched_at\":\"2026-09-10T08:53:26.032Z\",\"price\":5.2273,\"currency\":\"USD / USDT\",\"volume\":884179.285701,\"oi\":null,\"funding\":3.2e-05,\"interval\":8,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":1.3646922183507548,\"quoteAt\":\"2026-09-10T08:53:26.032Z\",\"quoteSource\":null,\"fundingBasis\":\"8h 等效 / 每小时结算\"},{\"venue\":\"lighter\",\"venue_name\":\"Lighter\",\"symbol\":\"UNITREE\",\"company_key\":\"UNITREE\",\"company_name\":\"宇树科技\",\"layer\":\"已上市公司\",\"status\":\"active\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"官方Lighter规格：688836.SH\",\"source_url\":\"https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails\",\"fetched_at\":\"2026-09-10T08:53:26.032Z\",\"price\":74.129,\"currency\":\"USD / USDT\",\"volume\":232018.989684,\"oi\":null,\"funding\":3.2e-05,\"interval\":8,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":-3.59878783149297,\"quoteAt\":\"2026-09-10T08:53:26.032Z\",\"quoteSource\":null,\"fundingBasis\":\"8h 等效 / 每小时结算\"},{\"venue\":\"lighter\",\"venue_name\":\"Lighter\",\"symbol\":\"MINIMAX\",\"company_key\":\"MINIMAX\",\"company_name\":\"MiniMax（稀宇科技）\",\"layer\":\"已上市公司\",\"status\":\"active\",\"directory_open\":true,\"caution\":\"\",\"reason\":\"\",\"anchor\":\"官方Lighter规格：0100.HK\",\"source_url\":\"https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails\",\"fetched_at\":\"2026-09-10T08:53:26.032Z\",\"price\":37.345,\"currency\":\"USD / USDT\",\"volume\":63663.022294,\"oi\":null,\"funding\":3.2e-05,\"interval\":8,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":-9.478307031513923,\"quoteAt\":\"2026-09-10T08:53:26.032Z\",\"quoteSource\":null,\"fundingBasis\":\"8h 等效 / 每小时结算\"}]},{\"venue\":\"bitmart\",\"name\":\"BitMart\",\"observedAt\":\"2026-09-10T08:53:28.016Z\",\"attemptedAt\":\"2026-09-10T08:53:28.016Z\",\"error\":null,\"quoteError\":null,\"rows\":[{\"venue\":\"bitmart\",\"venue_name\":\"BitMart\",\"symbol\":\"BABAUSDT\",\"company_key\":\"BABA\",\"company_name\":\"阿里巴巴\",\"layer\":\"美股中概补充\",\"status\":\"Delisted\",\"directory_open\":false,\"caution\":\"\",\"reason\":\"暂停 / 下架\",\"anchor\":\"US_MARKET\",\"source_url\":\"https://api-cloud-v2.bitmart.com/contract/public/details\",\"fetched_at\":\"2026-09-10T08:53:28.016Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"bitmart\",\"venue_name\":\"BitMart\",\"symbol\":\"JDUSDT\",\"company_key\":\"JD\",\"company_name\":\"京东\",\"layer\":\"美股中概补充\",\"status\":\"Delisted\",\"directory_open\":false,\"caution\":\"\",\"reason\":\"暂停 / 下架\",\"anchor\":\"US_MARKET\",\"source_url\":\"https://api-cloud-v2.bitmart.com/contract/public/details\",\"fetched_at\":\"2026-09-10T08:53:28.016Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"bitmart\",\"venue_name\":\"BitMart\",\"symbol\":\"FUTUUSDT\",\"company_key\":\"FUTU\",\"company_name\":\"富途控股\",\"layer\":\"美股中概补充\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"目录 Trading，但17只港股的24h成交字段均为0；两只抽查盘口为空，未确认可成交\",\"reason\":\"\",\"anchor\":\"US_MARKET\",\"source_url\":\"https://api-cloud-v2.bitmart.com/contract/public/details\",\"fetched_at\":\"2026-09-10T08:53:28.016Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"bitmart\",\"venue_name\":\"BitMart\",\"symbol\":\"TENCENTUSDT\",\"company_key\":\"TENCENT\",\"company_name\":\"腾讯控股\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"目录 Trading，但17只港股的24h成交字段均为0；两只抽查盘口为空，未确认可成交\",\"reason\":\"\",\"anchor\":\"HK_STOCK\",\"source_url\":\"https://api-cloud-v2.bitmart.com/contract/public/details\",\"fetched_at\":\"2026-09-10T08:53:28.016Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"bitmart\",\"venue_name\":\"BitMart\",\"symbol\":\"MEITUANUSDT\",\"company_key\":\"MEITUAN\",\"company_name\":\"美团\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"目录 Trading，但17只港股的24h成交字段均为0；两只抽查盘口为空，未确认可成交\",\"reason\":\"\",\"anchor\":\"HK_STOCK\",\"source_url\":\"https://api-cloud-v2.bitmart.com/contract/public/details\",\"fetched_at\":\"2026-09-10T08:53:28.016Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"bitmart\",\"venue_name\":\"BitMart\",\"symbol\":\"XIAOMIUSDT\",\"company_key\":\"XIAOMI\",\"company_name\":\"小米集团\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"目录 Trading，但17只港股的24h成交字段均为0；两只抽查盘口为空，未确认可成交\",\"reason\":\"\",\"anchor\":\"HK_STOCK\",\"source_url\":\"https://api-cloud-v2.bitmart.com/contract/public/details\",\"fetched_at\":\"2026-09-10T08:53:28.016Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"bitmart\",\"venue_name\":\"BitMart\",\"symbol\":\"KUAISHOUUSDT\",\"company_key\":\"KUAISHOU\",\"company_name\":\"快手科技\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"目录 Trading，但17只港股的24h成交字段均为0；两只抽查盘口为空，未确认可成交\",\"reason\":\"\",\"anchor\":\"HK_STOCK\",\"source_url\":\"https://api-cloud-v2.bitmart.com/contract/public/details\",\"fetched_at\":\"2026-09-10T08:53:28.016Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"bitmart\",\"venue_name\":\"BitMart\",\"symbol\":\"XUNCEUSDT\",\"company_key\":\"XUNCE\",\"company_name\":\"深圳迅策科技\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"目录 Trading，但17只港股的24h成交字段均为0；两只抽查盘口为空，未确认可成交\",\"reason\":\"\",\"anchor\":\"HK_STOCK\",\"source_url\":\"https://api-cloud-v2.bitmart.com/contract/public/details\",\"fetched_at\":\"2026-09-10T08:53:28.016Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"bitmart\",\"venue_name\":\"BitMart\",\"symbol\":\"ZHIPUUSDT\",\"company_key\":\"ZHIPU\",\"company_name\":\"智谱\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"目录 Trading，但17只港股的24h成交字段均为0；两只抽查盘口为空，未确认可成交\",\"reason\":\"\",\"anchor\":\"HK_STOCK\",\"source_url\":\"https://api-cloud-v2.bitmart.com/contract/public/details\",\"fetched_at\":\"2026-09-10T08:53:28.016Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"bitmart\",\"venue_name\":\"BitMart\",\"symbol\":\"MINIMAXUSDT\",\"company_key\":\"MINIMAX\",\"company_name\":\"MiniMax（稀宇科技）\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"目录 Trading，但17只港股的24h成交字段均为0；两只抽查盘口为空，未确认可成交\",\"reason\":\"\",\"anchor\":\"HK_STOCK\",\"source_url\":\"https://api-cloud-v2.bitmart.com/contract/public/details\",\"fetched_at\":\"2026-09-10T08:53:28.016Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"bitmart\",\"venue_name\":\"BitMart\",\"symbol\":\"LENOVOUSDT\",\"company_key\":\"LENOVO\",\"company_name\":\"联想集团\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"目录 Trading，但17只港股的24h成交字段均为0；两只抽查盘口为空，未确认可成交\",\"reason\":\"\",\"anchor\":\"HK_STOCK\",\"source_url\":\"https://api-cloud-v2.bitmart.com/contract/public/details\",\"fetched_at\":\"2026-09-10T08:53:28.016Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"bitmart\",\"venue_name\":\"BitMart\",\"symbol\":\"AKESOUSDT\",\"company_key\":\"AKESO\",\"company_name\":\"康方生物\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"目录 Trading，但17只港股的24h成交字段均为0；两只抽查盘口为空，未确认可成交\",\"reason\":\"\",\"anchor\":\"HK_STOCK\",\"source_url\":\"https://api-cloud-v2.bitmart.com/contract/public/details\",\"fetched_at\":\"2026-09-10T08:53:28.016Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"bitmart\",\"venue_name\":\"BitMart\",\"symbol\":\"CITICUSDT\",\"company_key\":\"CITIC\",\"company_name\":\"中信股份\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"目录 Trading，但17只港股的24h成交字段均为0；两只抽查盘口为空，未确认可成交\",\"reason\":\"\",\"anchor\":\"HK_STOCK\",\"source_url\":\"https://api-cloud-v2.bitmart.com/contract/public/details\",\"fetched_at\":\"2026-09-10T08:53:28.016Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"bitmart\",\"venue_name\":\"BitMart\",\"symbol\":\"SUNACUSDT\",\"company_key\":\"SUNAC\",\"company_name\":\"融创中国\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"目录 Trading，但17只港股的24h成交字段均为0；两只抽查盘口为空，未确认可成交\",\"reason\":\"\",\"anchor\":\"HK_STOCK\",\"source_url\":\"https://api-cloud-v2.bitmart.com/contract/public/details\",\"fetched_at\":\"2026-09-10T08:53:28.016Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"bitmart\",\"venue_name\":\"BitMart\",\"symbol\":\"SBPUSDT\",\"company_key\":\"SBP\",\"company_name\":\"中国生物制药\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"目录 Trading，但17只港股的24h成交字段均为0；两只抽查盘口为空，未确认可成交\",\"reason\":\"\",\"anchor\":\"HK_STOCK\",\"source_url\":\"https://api-cloud-v2.bitmart.com/contract/public/details\",\"fetched_at\":\"2026-09-10T08:53:28.016Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"bitmart\",\"venue_name\":\"BitMart\",\"symbol\":\"ANTAUSDT\",\"company_key\":\"ANTA\",\"company_name\":\"安踏体育\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"目录 Trading，但17只港股的24h成交字段均为0；两只抽查盘口为空，未确认可成交\",\"reason\":\"\",\"anchor\":\"HK_STOCK\",\"source_url\":\"https://api-cloud-v2.bitmart.com/contract/public/details\",\"fetched_at\":\"2026-09-10T08:53:28.016Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"bitmart\",\"venue_name\":\"BitMart\",\"symbol\":\"DEEPTECHUSDT\",\"company_key\":\"DEEPTECH\",\"company_name\":\"滴普科技\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"目录 Trading，但17只港股的24h成交字段均为0；两只抽查盘口为空，未确认可成交\",\"reason\":\"\",\"anchor\":\"HK_STOCK\",\"source_url\":\"https://api-cloud-v2.bitmart.com/contract/public/details\",\"fetched_at\":\"2026-09-10T08:53:28.016Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"bitmart\",\"venue_name\":\"BitMart\",\"symbol\":\"NIOUSDT\",\"company_key\":\"NIO\",\"company_name\":\"蔚来\",\"layer\":\"美股中概补充\",\"status\":\"Delisted\",\"directory_open\":false,\"caution\":\"\",\"reason\":\"暂停 / 下架\",\"anchor\":\"US_MARKET\",\"source_url\":\"https://api-cloud-v2.bitmart.com/contract/public/details\",\"fetched_at\":\"2026-09-10T08:53:28.016Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"bitmart\",\"venue_name\":\"BitMart\",\"symbol\":\"PDDUSDT\",\"company_key\":\"PDD\",\"company_name\":\"拼多多\",\"layer\":\"美股中概补充\",\"status\":\"Delisted\",\"directory_open\":false,\"caution\":\"\",\"reason\":\"暂停 / 下架\",\"anchor\":\"US_MARKET\",\"source_url\":\"https://api-cloud-v2.bitmart.com/contract/public/details\",\"fetched_at\":\"2026-09-10T08:53:28.016Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"bitmart\",\"venue_name\":\"BitMart\",\"symbol\":\"KBHLDUSDT\",\"company_key\":\"KBHLD\",\"company_name\":\"建滔集团\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"目录 Trading，但17只港股的24h成交字段均为0；两只抽查盘口为空，未确认可成交\",\"reason\":\"\",\"anchor\":\"HK_STOCK\",\"source_url\":\"https://api-cloud-v2.bitmart.com/contract/public/details\",\"fetched_at\":\"2026-09-10T08:53:28.016Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"bitmart\",\"venue_name\":\"BitMart\",\"symbol\":\"KBLAMUSDT\",\"company_key\":\"KBLAM\",\"company_name\":\"建滔积层板\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"目录 Trading，但17只港股的24h成交字段均为0；两只抽查盘口为空，未确认可成交\",\"reason\":\"\",\"anchor\":\"HK_STOCK\",\"source_url\":\"https://api-cloud-v2.bitmart.com/contract/public/details\",\"fetched_at\":\"2026-09-10T08:53:28.016Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"bitmart\",\"venue_name\":\"BitMart\",\"symbol\":\"POPMARTUSDT\",\"company_key\":\"POPMART\",\"company_name\":\"泡泡玛特\",\"layer\":\"已上市公司\",\"status\":\"Trading\",\"directory_open\":true,\"caution\":\"目录 Trading，但17只港股的24h成交字段均为0；两只抽查盘口为空，未确认可成交\",\"reason\":\"\",\"anchor\":\"HK_STOCK\",\"source_url\":\"https://api-cloud-v2.bitmart.com/contract/public/details\",\"fetched_at\":\"2026-09-10T08:53:28.016Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"bitmart\",\"venue_name\":\"BitMart\",\"symbol\":\"SMICUSDT\",\"company_key\":\"SMIC\",\"company_name\":\"中芯国际\",\"layer\":\"已上市公司\",\"status\":\"Delisted\",\"directory_open\":false,\"caution\":\"\",\"reason\":\"暂停 / 下架\",\"anchor\":\"HK_STOCK\",\"source_url\":\"https://api-cloud-v2.bitmart.com/contract/public/details\",\"fetched_at\":\"2026-09-10T08:53:28.016Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null},{\"venue\":\"bitmart\",\"venue_name\":\"BitMart\",\"symbol\":\"GIGADEVICEUSDT\",\"company_key\":\"GIGADEV\",\"company_name\":\"兆易创新\",\"layer\":\"已上市公司\",\"status\":\"Delisted\",\"directory_open\":false,\"caution\":\"\",\"reason\":\"暂停 / 下架\",\"anchor\":\"HK_STOCK\",\"source_url\":\"https://api-cloud-v2.bitmart.com/contract/public/details\",\"fetched_at\":\"2026-09-10T08:53:28.016Z\",\"price\":null,\"currency\":\"USD / USDT\",\"volume\":null,\"oi\":null,\"funding\":null,\"interval\":null,\"nextFunding\":null,\"bid\":null,\"ask\":null,\"change\":null,\"quoteAt\":null,\"quoteSource\":null}]}]");
//#endregion
//#region data/share-class-evidence.json
var share_class_evidence_default = {
	"gate:TENCENT_USDT": {
		"market": "HK",
		"reference": "0700.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/50661",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:MEITUAN_USDT": {
		"market": "HK",
		"reference": "3690.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/50661",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:XIAOMI_USDT": {
		"market": "HK",
		"reference": "1810.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/50661",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:KUAISHOU_USDT": {
		"market": "HK",
		"reference": "1024.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/50661",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:XUNCE_USDT": {
		"market": "HK",
		"reference": "3317.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/50661",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:ZHIPU_USDT": {
		"market": "HK",
		"reference": "2513.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/50661",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:GEELY_USDT": {
		"market": "HK",
		"reference": "0175.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/50661",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:MINIMAX_USDT": {
		"market": "HK",
		"reference": "0100.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/50682",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:LENOVO_USDT": {
		"market": "HK",
		"reference": "0992.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/50682",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:AKESO_USDT": {
		"market": "HK",
		"reference": "9926.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/50682",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:CITIC_USDT": {
		"market": "HK",
		"reference": "0267.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/50682",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:SUNAC_USDT": {
		"market": "HK",
		"reference": "1918.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/50682",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:SBP_USDT": {
		"market": "HK",
		"reference": "1177.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/50682",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:ANTA_USDT": {
		"market": "HK",
		"reference": "2020.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/50682",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:DEEPTECH_USDT": {
		"market": "HK",
		"reference": "1384.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/50682",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:TENCENTHKD_USDT": {
		"market": "HK",
		"reference": "0700.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/100769",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:ZHIPUHKD_USDT": {
		"market": "HK",
		"reference": "2513.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/100769",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:MINIMAXHKD_USDT": {
		"market": "HK",
		"reference": "0100.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/100769",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:XIAOMIHKD_USDT": {
		"market": "HK",
		"reference": "1810.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/100769",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:GIGADEV_USDT": {
		"market": "HK",
		"reference": "3986.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/100971",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:SMIC_USDT": {
		"market": "HK",
		"reference": "0981.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/100971",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:HHGRACE_USDT": {
		"market": "HK",
		"reference": "1347.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/100971",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:BYD_USDT": {
		"market": "HK",
		"reference": "1211.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/100971",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:CATL_USDT": {
		"market": "HK",
		"reference": "3750.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/100971",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:ZIJINMINING_USDT": {
		"market": "HK",
		"reference": "2899.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/100971",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:YOFC_USDT": {
		"market": "HK",
		"reference": "6869.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/100971",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:SHENHUA_USDT": {
		"market": "A",
		"reference": "601088.SH",
		"source_url": "https://www.gate.com/zh/announcements/article/101195",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:YANGTZE_USDT": {
		"market": "A",
		"reference": "600900.SH",
		"source_url": "https://www.gate.com/zh/announcements/article/101195",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:HYGON_USDT": {
		"market": "A",
		"reference": "688041.SH",
		"source_url": "https://www.gate.com/zh/announcements/article/101195",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:MIDEA_USDT": {
		"market": "A",
		"reference": "000333.SZ",
		"source_url": "https://www.gate.com/zh/announcements/article/101195",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:BEIGENE_USDT": {
		"market": "A",
		"reference": "688235.SH",
		"source_url": "https://www.gate.com/zh/announcements/article/101195",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:MOUTAI_USDT": {
		"market": "A",
		"reference": "600519.SH",
		"source_url": "https://www.gate.com/zh/announcements/article/101195",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:HENGRUI_USDT": {
		"market": "A",
		"reference": "600276.SH",
		"source_url": "https://www.gate.com/zh/announcements/article/101195",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:BIWIN_USDT": {
		"market": "A",
		"reference": "688525.SH",
		"source_url": "https://www.gate.com/zh/announcements/article/101195",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:DEMINGLI_USDT": {
		"market": "A",
		"reference": "001309.SZ",
		"source_url": "https://www.gate.com/zh/announcements/article/101195",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:TAIJI_USDT": {
		"market": "A",
		"reference": "600667.SH",
		"source_url": "https://www.gate.com/zh/announcements/article/101195",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:ACCELINK_USDT": {
		"market": "A",
		"reference": "002281.SZ",
		"source_url": "https://www.gate.com/zh/announcements/article/101200",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:PUYA_USDT": {
		"market": "A",
		"reference": "688766.SH",
		"source_url": "https://www.gate.com/zh/announcements/article/101200",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:HUAGONGTECH_USDT": {
		"market": "A",
		"reference": "000988.SZ",
		"source_url": "https://www.gate.com/zh/announcements/article/101200",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:WANGSU_USDT": {
		"market": "A",
		"reference": "300017.SZ",
		"source_url": "https://www.gate.com/zh/announcements/article/101200",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:CIG_USDT": {
		"market": "A",
		"reference": "603083.SH",
		"source_url": "https://www.gate.com/zh/announcements/article/101200",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:TONGGUAN_USDT": {
		"market": "A",
		"reference": "301217.SZ",
		"source_url": "https://www.gate.com/zh/announcements/article/101200",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码",
		"company_name": "铜冠铜箔"
	},
	"gate:JUNZHENG_USDT": {
		"market": "A",
		"reference": "300223.SZ",
		"source_url": "https://www.gate.com/zh/announcements/article/101200",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:XIECHUANG_USDT": {
		"market": "A",
		"reference": "300857.SZ",
		"source_url": "https://www.gate.com/zh/announcements/article/101200",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:YONGDING_USDT": {
		"market": "A",
		"reference": "600105.SH",
		"source_url": "https://www.gate.com/zh/announcements/article/101200",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:LETTALL_USDT": {
		"market": "A",
		"reference": "603629.SH",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=2",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:HTGD_USDT": {
		"market": "A",
		"reference": "600487.SH",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=2",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:CAMBRICON_USDT": {
		"market": "A",
		"reference": "688256.SH",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=2",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:EOPTOLINK_USDT": {
		"market": "A",
		"reference": "300502.SZ",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=2",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:YJTECH_USDT": {
		"market": "A",
		"reference": "688498.SH",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=2",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:SYTECH_USDT": {
		"market": "A",
		"reference": "600183.SH",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=2",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:BLUEFOCUS_USDT": {
		"market": "A",
		"reference": "300058.SZ",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=2",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:SUNGROW_USDT": {
		"market": "A",
		"reference": "300274.SZ",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=2",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:BOE_USDT": {
		"market": "A",
		"reference": "000725.SZ",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=2",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:CMOC_USDT": {
		"market": "A",
		"reference": "603993.SH",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=2",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:SINOCERA_USDT": {
		"market": "A",
		"reference": "300285.SZ",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=3",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:LUXSHARE_USDT": {
		"market": "A",
		"reference": "002475.SZ",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=3",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:CJS_USDT": {
		"market": "A",
		"reference": "600176.SH",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=3",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:AMEC_USDT": {
		"market": "A",
		"reference": "688012.SH",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=3",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:DSBJ_USDT": {
		"market": "A",
		"reference": "002384.SZ",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=3",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:FII_USDT": {
		"market": "A",
		"reference": "601138.SH",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=3",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:IEIT_USDT": {
		"market": "A",
		"reference": "000977.SZ",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=3",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:TUNGSTEN_USDT": {
		"market": "A",
		"reference": "000657.SZ",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=3",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:PERIC_USDT": {
		"market": "A",
		"reference": "688146.SH",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=4",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:FENGHUA_USDT": {
		"market": "A",
		"reference": "000636.SZ",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=4",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:WUXIAPPTEC_USDT": {
		"market": "A",
		"reference": "603259.SH",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=4",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:NAURA_USDT": {
		"market": "A",
		"reference": "002371.SZ",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=4",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:LONGSYS_USDT": {
		"market": "A",
		"reference": "301308.SZ",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=4",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:CCTC_USDT": {
		"market": "A",
		"reference": "300408.SZ",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=4",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:ZTT_USDT": {
		"market": "A",
		"reference": "600522.SH",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=5",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:MONTAGE_USDT": {
		"market": "A",
		"reference": "688008.SH",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=5",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:UNIS_USDT": {
		"market": "A",
		"reference": "000938.SZ",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=5",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"gate:TFME_USDT": {
		"market": "A",
		"reference": "002156.SZ",
		"source_url": "https://www.gate.com/zh/price/crypto-category/newlisting-futures?page=5",
		"verified_at": "2026-09-10",
		"note": "Gate官方材料明确标注该合约对应上市代码"
	},
	"bybit:SMICUSDT": {
		"market": "HK",
		"reference": "00981.HK",
		"source_url": "https://www.bybit.com/en/learn/bybit-tradfi/trade-smic-perpetuals",
		"verified_at": "2026-09-11",
		"note": "Bybit 2026-08-19 逐合约产品指南明确追踪 HKEX 0981；采用明确的产品定义。通用 instruments API 的 US/SMIC 标签与该产品定义不一致，不能据此归为美股。",
		"additional_sources": ["https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=SMICUSDT", "https://api.bybit.com/v5/market/index-price-components?indexName=SMICUSDT"]
	},
	"hyperliquid_xyz:xyz:BABA": {
		"market": "US",
		"reference": "NYSE:BABA · ADS",
		"source_url": "https://docs.trade.xyz/consolidated-resources/specification-index",
		"verified_at": "2026-09-11",
		"note": "XYZ 官方规格明确：BABA 对应阿里巴巴 1 份 American depositary share，以 USD 报价。"
	},
	"lighter:BYD": {
		"market": "HK",
		"reference": "港股；产品名称与 00285.HK 链接不一致",
		"source_url": "https://docs.lighter.xyz/trading/real-world-assets-rwas/market-specifications",
		"verified_at": "2026-09-11",
		"note": "参考市场可以确定为港股，但规格正文 BYD Company 与 Pyth 00285.HK（比亚迪电子）不是同一发行人；不将其与其他场所的比亚迪合约比较。",
		"exclude_from_monitor": true,
		"exclusion_reason": "该市场只可减仓，当前成交和持仓均为 0；官方产品名称与预言机链接对应不同公司，已从可监控合约中移除。",
		"additional_sources": ["https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails", "https://app.pyth.com/explore/Equity.HK.0285%2FHKD"]
	},
	"gate:BABA_USDT": {
		"market": "US",
		"reference": "NYSE:BABA",
		"source_url": "https://www.gate.com/zh/price/baba-baba",
		"note": "Gate官方产品页明确BABA为阿里巴巴纽约证券交易所股票代码，标注USStock，相关交易直接列出BABA/USDT永续合约。",
		"verified_at": "2026-09-11"
	},
	"gate:CXMT_USDT": {
		"market": "A",
		"reference": "688825.SH",
		"source_url": "https://www.gate.com/zh/news/detail/cxmtusdt-pre-market-perpetual-futures-contracts-will-be-migrated-to-futures-22957411",
		"note": "Gate官方迁移消息明确CXMTUSDT对应长鑫科技688825.SH，并在股票上市后迁移正式合约；当前官方API为stocks、trading、is_pre_market=false。原迁移公告100836已重定向至公告首页，使用Gate自有公告摘要及当前API闭环。",
		"verified_at": "2026-09-11",
		"additional_sources": ["https://api.gateio.ws/api/v4/futures/usdt/contracts/CXMT_USDT"]
	},
	"gate:FUTUON_USDT": {
		"market": "US",
		"reference": "NASDAQ:FUTU（Ondo FUTUon）",
		"source_url": "https://www.gate.com/zh/announcements/article/48153",
		"note": "Gate明确上线FUTUON/USDT股票代币永续合约；Ondo官方FUTUon资产页Underlying Asset Name为Futu Holdings Limited American Depositary Shares、Ticker为FUTU。合约关联代币化ADS，不能当作1:1直接股票合约；份额/代币会因分红再投资变化。",
		"verified_at": "2026-09-11",
		"additional_sources": ["https://app.ondo.finance/assets/futuon", "https://www.gate.com/zh/how-to-buy/futu-holdings-tokenized-stock-futuon"]
	},
	"gate:JD_USDT": {
		"market": "US",
		"reference": "NASDAQ:JD（Ondo JDon）",
		"source_url": "https://www.gate.com/zh/help/annlist/others/101439",
		"note": "Gate官方公告明确JDON更名为JD，仅变更交易符号、标的及规则保持一致，且给出JD_USDT交易链接；Ondo JDon官方底层是JD.com American Depositary Shares。仍属代币化ADS相关合约，不能因移除ON后缀误认为直接ADR。",
		"verified_at": "2026-09-11",
		"additional_sources": ["https://app.ondo.finance/assets/jdon", "https://www.gate.com/zh/announcements/article/48153"]
	},
	"gate:LAOPU_USDT": {
		"market": "HK",
		"reference": "06181.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/101526",
		"note": "Gate官方上线公告直接注明LAOPU永续合约对应老铺黄金06181.HK。",
		"verified_at": "2026-09-11"
	},
	"gate:PDD_USDT": {
		"market": "US",
		"reference": "NASDAQ:PDD",
		"source_url": "https://www.gate.com/id/price/pdd-holdings-inc.-pdd",
		"note": "Gate官方PDD产品页列PDD Holdings Inc.、USStock标签和Futures PDD/USDT交易，确定为美股PDD线。",
		"verified_at": "2026-09-11"
	},
	"gate:POPMART_USDT": {
		"market": "HK",
		"reference": "09992.HK",
		"source_url": "https://www.gate.com/es/news/detail/gate-contract-stock-zone-will-launch-kbhld-kblam-popmart-perpetual-contract-22126155",
		"note": "Gate自有官方上市消息明确6月26日上线POPMART泡泡玛特09992.HK的USDT结算永续合约，与CFD专区不同。",
		"verified_at": "2026-09-11"
	},
	"gate:SHEIN_USDT": {
		"market": "HK",
		"reference": "00625.HK",
		"source_url": "https://www.gate.com/zh/help/annlist/others/101461",
		"note": "Gate官方迁移公告明确SHEINUSDT对应00625.HK；当前官方API为stocks、trading、is_pre_market=false，已不是盘前产品。",
		"verified_at": "2026-09-11",
		"additional_sources": ["https://api.gateio.ws/api/v4/futures/usdt/contracts/SHEIN_USDT"]
	},
	"gate:SHTECH_USDT": {
		"market": "A",
		"reference": "300476.SZ",
		"source_url": "https://www.gate.com/ar/price/shenghong-technology-300476.sz-shtech",
		"note": "Gate官方产品名称直接为Shenghong Technology 300476.SZ，标注A-Shares，相关交易为Futures SHTECH/USDT，故此合约为A股线。",
		"verified_at": "2026-09-11",
		"additional_sources": ["https://www.gate.com/zh/how-to-buy/shenghong-technology-300476.sz-shtech"]
	},
	"gate:TFC_USDT": {
		"market": "A",
		"reference": "300394.SZ",
		"source_url": "https://www.gate.com/zh/price/tfc-optical-300394.sz-tfc",
		"note": "Gate官方产品页明确天孚通信300394.SZ并列永续合约TFC/USDT；官方TFC_USDT合约计算器亦以TFC Optical 300394.SZ命名。",
		"verified_at": "2026-09-11",
		"additional_sources": ["https://www.gate.com/es/futures-calculator/liquidation_price-TFC_USDT"]
	},
	"gate:UNITREE_USDT": {
		"market": "A",
		"reference": "688836.SH",
		"source_url": "https://www.gate.com/zh/help/annlist/others/101203/gate-announcement-on-migration-of-unitreeusdt-pre-market-perpetual-contract-to-official-perpetual-contract-trading",
		"note": "Gate官方迁移公告明确UNITREEUSDT对应宇树科技688836.SH；当前官方API为stocks、trading、is_pre_market=false，已不是盘前产品。",
		"verified_at": "2026-09-11",
		"additional_sources": ["https://api.gateio.ws/api/v4/futures/usdt/contracts/UNITREE_USDT"]
	},
	"gate:ZHONGJI_USDT": {
		"market": "HK",
		"reference": "03308.HK",
		"source_url": "https://www.gate.com/zh/announcements/article/101141",
		"note": "Gate8月13日官方公告直接把ZHONGJI永续合约映射中际旭创03308.HK；无需仅依赖旧符号ZJINNOLIGHT的公司名推断。",
		"verified_at": "2026-09-11"
	},
	"binance:BABAUSDT": {
		"market": "US",
		"reference": "NYSE:BABA",
		"source_url": "https://www.binance.com/en/support/announcement/detail/16fe15060947481ab240fb398230a3ee",
		"note": "Binance官方合约规格Underlying Equity明确Alibaba Group Holdings Ltd ADR (NYSE:BABA)，且说明BABAUSDT跟踪该ADR价格。",
		"verified_at": "2026-09-11"
	},
	"binance:PDDUSDT": {
		"market": "US",
		"reference": "NASDAQ:PDD",
		"source_url": "https://www.binance.com/en/support/announcement/detail/32ac927d1cbe4aa3b527eca1c401a98f",
		"note": "Binance官方8月28日上市规格Underlying Equity/Index明确PDD Holdings Inc. American Depositary Shares (Nasdaq:PDD)。",
		"verified_at": "2026-09-11"
	},
	"htx:BABA-USDT": {
		"market": "US",
		"reference": "NYSE:BABA",
		"source_url": "https://www.htx.com/tokens/BABA/",
		"additional_sources": [
			"https://api.hbdm.com/linear-swap-api/market/swap_contract_constituents?contract_code=BABA-USDT",
			"https://fapi.binance.com/fapi/v1/exchangeInfo",
			"https://www.binance.com/en/support/announcement/detail/16fe15060947481ab240fb398230a3ee"
		],
		"note": "HTX官方产品介绍明确该合约跟踪NYSE:BABA；并以当前合约目录与指数成分复核。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-product-introduction"
	},
	"htx:BYD-USDT": {
		"market": "HK",
		"reference": "01211.HK",
		"source_url": "https://www.htx.com/tokens/BYD/",
		"additional_sources": ["https://api.hbdm.com/linear-swap-api/market/swap_contract_constituents?contract_code=BYD-USDT", "https://fapi.binance.com/fapi/v1/exchangeInfo"],
		"note": "HTX官方产品介绍明确该合约跟踪01211.HK；并以当前合约目录与指数成分复核。产品说明明确H shares。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-product-introduction"
	},
	"htx:CXMT-USDT": {
		"market": "A",
		"reference": "688825.SH",
		"source_url": "https://www.htx.com/tokens/CXMT/",
		"additional_sources": [
			"https://api.hbdm.com/linear-swap-api/market/swap_contract_constituents?contract_code=CXMT-USDT",
			"https://fapi.binance.com/fapi/v1/exchangeInfo",
			"https://docs.trade.xyz/perpetuals/specifications-and-schedules/specification-index"
		],
		"note": "HTX官方产品介绍明确该合约跟踪688825.SH；并以当前合约目录与指数成分复核。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-product-introduction"
	},
	"htx:GIGADEV-USDT": {
		"market": "HK",
		"reference": "03986.HK",
		"source_url": "https://www.htx.com/tokens/GIGADEV/",
		"additional_sources": ["https://api.hbdm.com/linear-swap-api/market/swap_contract_constituents?contract_code=GIGADEV-USDT", "https://fapi.binance.com/fapi/v1/exchangeInfo"],
		"note": "HTX官方产品介绍明确该合约跟踪03986.HK；并以当前合约目录与指数成分复核。产品说明明确H shares。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-product-introduction"
	},
	"htx:HK0625-USDT": {
		"market": "HK",
		"reference": "00625.HK",
		"source_url": "https://www.htx.com/tokens/HK0625/",
		"additional_sources": ["https://api.hbdm.com/linear-swap-api/market/swap_contract_constituents?contract_code=HK0625-USDT", "https://fapi.binance.com/fapi/v1/exchangeInfo"],
		"note": "HTX官方产品介绍明确该合约跟踪00625.HK；并以当前合约目录与指数成分复核。该介绍明确为quanto：底层港币报价，保证金及盈亏USDT结算，1:1数值使用且不作FX换算。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-product-introduction"
	},
	"htx:HK0700-USDT": {
		"market": "HK",
		"reference": "00700.HK",
		"source_url": "https://www.htx.com/tokens/HK0700/",
		"additional_sources": ["https://api.hbdm.com/linear-swap-api/market/swap_contract_constituents?contract_code=HK0700-USDT", "https://fapi.binance.com/fapi/v1/exchangeInfo"],
		"note": "HTX官方产品介绍明确该合约跟踪00700.HK；并以当前合约目录与指数成分复核。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-product-introduction"
	},
	"htx:HK1810-USDT": {
		"market": "HK",
		"reference": "01810.HK",
		"source_url": "https://www.htx.com/tokens/HK1810/",
		"additional_sources": ["https://api.hbdm.com/linear-swap-api/market/swap_contract_constituents?contract_code=HK1810-USDT", "https://fapi.binance.com/fapi/v1/exchangeInfo"],
		"note": "HTX官方产品介绍明确该合约跟踪01810.HK；并以当前合约目录与指数成分复核。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-product-introduction"
	},
	"htx:JD-USDT": {
		"market": "US",
		"reference": "NASDAQ:JD",
		"source_url": "https://api.hbdm.com/linear-swap-api/market/swap_contract_constituents?contract_code=JD-USDT",
		"additional_sources": ["https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=JDUSDT"],
		"note": "官方当前复合指数成分为Kaiko JD-USDT；Pyth JD-USDT；Massive JD-USDT；Bybit_Futures JD-USDT；Dxfeed JD-USDT。按上述精确外部合约成分及上游官方规格核定股类；这属于复合指数锚定，不代表现货交割。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-index-component-chain"
	},
	"htx:KUAISHOU-USDT": {
		"market": "HK",
		"reference": "01024.HK",
		"source_url": "https://www.htx.com/tokens/KUAISHOU/",
		"additional_sources": ["https://api.hbdm.com/linear-swap-api/market/swap_contract_constituents?contract_code=KUAISHOU-USDT", "https://fapi.binance.com/fapi/v1/exchangeInfo"],
		"note": "HTX官方产品介绍明确该合约跟踪01024.HK；并以当前合约目录与指数成分复核。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-product-introduction"
	},
	"htx:MEITUAN-USDT": {
		"market": "HK",
		"reference": "03690.HK",
		"source_url": "https://www.htx.com/tokens/MEITUAN/",
		"additional_sources": ["https://api.hbdm.com/linear-swap-api/market/swap_contract_constituents?contract_code=MEITUAN-USDT", "https://fapi.binance.com/fapi/v1/exchangeInfo"],
		"note": "HTX官方产品介绍明确该合约跟踪03690.HK；并以当前合约目录与指数成分复核。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-product-introduction"
	},
	"htx:MINIMAX-USDT": {
		"market": "HK",
		"reference": "00100.HK",
		"source_url": "https://api.hbdm.com/linear-swap-api/market/swap_contract_constituents?contract_code=MINIMAX-USDT",
		"additional_sources": ["https://docs.trade.xyz/perpetuals/specifications-and-schedules/specification-index"],
		"note": "官方当前复合指数成分为Mexc_Futures MINIMAXSTOCK-USDT；Gate_Futures MINIMAX-USDT；Hyperliquid MINIMAX-USDT。按上述精确外部合约成分及上游官方规格核定股类；这属于复合指数锚定，不代表现货交割。HTX tokens介绍页误写02417.HK；官方实时指数主要连接Hyperliquid的MINIMAX，具体上游规范为00100.HK，以后者核定。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-index-component-chain"
	},
	"htx:PDD-USDT": {
		"market": "US",
		"reference": "NASDAQ:PDD",
		"source_url": "https://api.hbdm.com/linear-swap-api/market/swap_contract_constituents?contract_code=PDD-USDT",
		"additional_sources": ["https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=PDDUSDT"],
		"note": "官方当前复合指数成分为Kaiko PDD-USDT；Pyth PDD-USDT；Massive PDD-USDT；Bybit_Futures PDD-USDT；Dxfeed PDD-USDT。按上述精确外部合约成分及上游官方规格核定股类；这属于复合指数锚定，不代表现货交割。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-index-component-chain"
	},
	"htx:POPMART-USDT": {
		"market": "HK",
		"reference": "09992.HK",
		"source_url": "https://www.htx.com/tokens/POPMART/",
		"additional_sources": ["https://api.hbdm.com/linear-swap-api/market/swap_contract_constituents?contract_code=POPMART-USDT", "https://fapi.binance.com/fapi/v1/exchangeInfo"],
		"note": "HTX官方产品介绍明确该合约跟踪09992.HK；并以当前合约目录与指数成分复核。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-product-introduction"
	},
	"htx:SHEIN-USDT": {
		"market": "HK",
		"reference": "00625.HK",
		"source_url": "https://api.hbdm.com/linear-swap-api/market/swap_contract_constituents?contract_code=SHEIN-USDT",
		"additional_sources": ["https://docs.trade.xyz/perpetuals/specifications-and-schedules/specification-index"],
		"note": "官方当前复合指数成分为Hyperliquid_index SHEIN-USDT。按上述精确外部合约成分及上游官方规格核定股类；这属于复合指数锚定，不代表现货交割。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-index-component-chain"
	},
	"htx:SMIC-USDT": {
		"market": "HK",
		"reference": "00981.HK",
		"source_url": "https://api.hbdm.com/linear-swap-api/market/swap_contract_constituents?contract_code=SMIC-USDT",
		"additional_sources": ["https://www.bybit.com/en/learn/bybit-tradfi/trade-smic-perpetuals"],
		"note": "官方当前复合指数成分为Bybit_Futures SMIC-USDT。按上述精确外部合约成分及上游官方规格核定股类；这属于复合指数锚定，不代表现货交割。Bybit产品指南明确HKEX0981；其API通用US字段存在差异，以具体股票指南为准。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-index-component-chain"
	},
	"htx:TENCENT-USDT": {
		"market": "HK",
		"reference": "00700.HK",
		"source_url": "https://www.htx.com/tokens/TENCENT/",
		"additional_sources": ["https://api.hbdm.com/linear-swap-api/market/swap_contract_constituents?contract_code=TENCENT-USDT"],
		"note": "HTX官方产品介绍明确TENCENTUSDT Perpetual Contract跟踪Tencent Holdings Limited Common Stock，HKEX00700.HK。当前指数为PythPro数据源，股类由该具体合约说明核定。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-product-introduction"
	},
	"htx:UNITREE-USDT": {
		"market": "A",
		"reference": "688836.SH",
		"source_url": "https://www.htx.com/tokens/UNITREE/",
		"additional_sources": [
			"https://api.hbdm.com/linear-swap-api/market/swap_contract_constituents?contract_code=UNITREE-USDT",
			"https://fapi.binance.com/fapi/v1/exchangeInfo",
			"https://docs.trade.xyz/perpetuals/specifications-and-schedules/specification-index"
		],
		"note": "HTX官方产品介绍明确该合约跟踪688836.SH；并以当前合约目录与指数成分复核。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-product-introduction"
	},
	"htx:ZHIPU-USDT": {
		"market": "HK",
		"reference": "02513.HK",
		"source_url": "https://api.hbdm.com/linear-swap-api/market/swap_contract_constituents?contract_code=ZHIPU-USDT",
		"additional_sources": ["https://www.binance.com/en/support/announcement/detail/18724cba64a048938986a98bbb257258"],
		"note": "HTX 当前 ZHIPU-USDT 指数成分包含 Binance Futures 的 ZHIPU-USDT（另有 Kaiko/Pyth 现货源）。Binance 2026-07-16 正式上市公告逐列明确 ZHIPUUSDT 的标的为 Knowledge Atlas Technology JSC Ltd，HKEX 2513。HTX tokens/ZHIPU 产品介绍页将代码写成 02587，与其实际指数成分对应的正式上游合约规格不一致；采用指数链与 Binance 精确合约公告确认港股 02513。XYZ 不在当前该指数成分中，不作为本行证据。",
		"verified_at": "2026-09-10T17:58:10.357327+00:00",
		"evidence_kind": "official-index-component-chain"
	},
	"htx:ZHONGJI-USDT": {
		"market": "HK",
		"reference": "03308.HK",
		"source_url": "https://www.htx.com/tokens/ZHONGJI/",
		"additional_sources": ["https://api.hbdm.com/linear-swap-api/market/swap_contract_constituents?contract_code=ZHONGJI-USDT", "https://fapi.binance.com/fapi/v1/exchangeInfo"],
		"note": "HTX官方产品介绍明确该合约跟踪03308.HK；并以当前合约目录与指数成分复核。产品说明明确H shares。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-product-introduction"
	},
	"okx:CXMT-USDT-SWAP": {
		"market": "A",
		"reference": "688825.SH",
		"source_url": "https://www.okx.com/api/v5/market/index-components?index=CXMT-USDT",
		"additional_sources": ["https://fapi.binance.com/fapi/v1/exchangeInfo", "https://docs.trade.xyz/perpetuals/specifications-and-schedules/specification-index"],
		"note": "官方当前复合指数成分为Hyperliquid_Oracle CXMT/USD；Binance_Index CXMT/USDT。按上述精确外部合约成分及上游官方规格核定股类；这属于复合指数锚定，不代表现货交割。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-index-component-chain"
	},
	"okx:MINIMAX-USDT-SWAP": {
		"market": "HK",
		"reference": "00100.HK",
		"source_url": "https://www.okx.com/api/v5/market/index-components?index=MINIMAX-USDT",
		"additional_sources": ["https://docs.trade.xyz/perpetuals/specifications-and-schedules/specification-index"],
		"note": "官方当前复合指数成分为Hyperliquid_Oracle MINIMAX/USD。按上述精确外部合约成分及上游官方规格核定股类；这属于复合指数锚定，不代表现货交割。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-index-component-chain"
	},
	"okx:POPMART-USDT-SWAP": {
		"market": "HK",
		"reference": "09992.HK",
		"source_url": "https://www.okx.com/api/v5/market/index-components?index=POPMART-USDT",
		"additional_sources": ["https://fapi.binance.com/fapi/v1/exchangeInfo"],
		"note": "官方当前复合指数成分为Binance_Index POPMART/USDT。按上述精确外部合约成分及上游官方规格核定股类；这属于复合指数锚定，不代表现货交割。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-index-component-chain"
	},
	"okx:SHEIN-USDT-SWAP": {
		"market": "HK",
		"reference": "00625.HK",
		"source_url": "https://www.okx.com/api/v5/market/index-components?index=SHEIN-USDT",
		"additional_sources": ["https://docs.trade.xyz/perpetuals/specifications-and-schedules/specification-index"],
		"note": "官方当前复合指数成分为Binance_Index HK0625/USDT；Hyperliquid_Oracle SHEIN/USD。按上述精确外部合约成分及上游官方规格核定股类；这属于复合指数锚定，不代表现货交割。接口明确返回港股编号，并提供换汇后的cnvPx。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-index-component-chain"
	},
	"okx:UNITREE-USDT-SWAP": {
		"market": "A",
		"reference": "688836.SH",
		"source_url": "https://www.okx.com/api/v5/market/index-components?index=UNITREE-USDT",
		"additional_sources": ["https://fapi.binance.com/fapi/v1/exchangeInfo", "https://docs.trade.xyz/perpetuals/specifications-and-schedules/specification-index"],
		"note": "官方当前复合指数成分为Hyperliquid_Oracle UNITREE/USD；Binance_Index UNITREE/USDT。按上述精确外部合约成分及上游官方规格核定股类；这属于复合指数锚定，不代表现货交割。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-index-component-chain"
	},
	"okx:XIAOMI-USDT-SWAP": {
		"market": "HK",
		"reference": "01810.HK",
		"source_url": "https://www.okx.com/api/v5/market/index-components?index=XIAOMI-USDT",
		"additional_sources": ["https://fapi.binance.com/fapi/v1/exchangeInfo"],
		"note": "官方当前复合指数成分为Binance_Index HK1810/USDT。按上述精确外部合约成分及上游官方规格核定股类；这属于复合指数锚定，不代表现货交割。接口明确返回港股编号，并提供换汇后的cnvPx。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-index-component-chain"
	},
	"okx:ZHIPU-USDT-SWAP": {
		"market": "HK",
		"reference": "02513.HK",
		"source_url": "https://www.okx.com/api/v5/market/index-components?index=ZHIPU-USDT",
		"additional_sources": ["https://docs.trade.xyz/perpetuals/specifications-and-schedules/specification-index"],
		"note": "官方当前复合指数成分为Hyperliquid_Oracle ZHIPU/USD。按上述精确外部合约成分及上游官方规格核定股类；这属于复合指数锚定，不代表现货交割。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-index-component-chain"
	},
	"okx:ZHONGJI-USDT-SWAP": {
		"market": "HK",
		"reference": "03308.HK",
		"source_url": "https://www.okx.com/api/v5/market/index-components?index=ZHONGJI-USDT",
		"additional_sources": ["https://fapi.binance.com/fapi/v1/exchangeInfo"],
		"note": "官方当前复合指数成分为Binance_Index ZHONGJI/USDT。按上述精确外部合约成分及上游官方规格核定股类；这属于复合指数锚定，不代表现货交割。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-index-component-chain"
	},
	"xt:byd_usdt": {
		"market": "HK",
		"reference": "01211.HK",
		"source_url": "https://xtsupport.zendesk.com/api/v2/help_center/en-us/articles/61978109493145.json",
		"additional_sources": ["https://xtsupport.zendesk.com/hc/en-us/articles/61978109493145-XT-Announcement-on-the-Launch-of-Multiple-USDT-M-TradFi-Perpetual-Futures-2026-09-07"],
		"note": "XT官方上市公告Underlying Asset Tracked逐合约表明确列出01211.HK。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-announcement"
	},
	"xt:cxmt_usdt": {
		"market": "A",
		"reference": "688825.SH",
		"source_url": "https://xtsupport.zendesk.com/api/v2/help_center/en-us/articles/61236766969113.json",
		"additional_sources": ["https://xtsupport.zendesk.com/hc/en-us/articles/61236766969113-XT-Announcement-on-the-Launch-of-Multiple-USDT-M-TradFi-Perpetual-Futures-2026-08-17-2026-08-18"],
		"note": "XT官方上市公告Underlying Asset Tracked逐合约表明确列出688825.SH。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-announcement"
	},
	"xt:gigadev_usdt": {
		"market": "HK",
		"reference": "03986.HK",
		"source_url": "https://xtsupport.zendesk.com/api/v2/help_center/en-us/articles/60721414219033.json",
		"additional_sources": ["https://xtsupport.zendesk.com/hc/en-us/articles/60721414219033-XT-Announcement-on-the-Launch-of-GIGADEVUSDT-USDT-M-TradFi-Perpetual-Futures-2026-08-03"],
		"note": "XT官方上市公告Underlying Asset Tracked逐合约表明确列出03986.HK。产品时段接口曾返回TRADFI_A，属于较泛化的时段模板；以上市公告明确的H shares为分类证据。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-announcement"
	},
	"xt:kuaishou_usdt": {
		"market": "HK",
		"reference": "01024.HK",
		"source_url": "https://xtsupport.zendesk.com/api/v2/help_center/en-us/articles/61016521350809.json",
		"additional_sources": ["https://xtsupport.zendesk.com/hc/en-us/articles/61016521350809-XT-Announcement-on-the-Launch-of-Multiple-USDT-M-TradFi-Perpetual-Futures-2026-08-11"],
		"note": "XT官方上市公告Underlying Asset Tracked逐合约表明确列出01024.HK。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-announcement"
	},
	"xt:meituan_usdt": {
		"market": "HK",
		"reference": "03690.HK",
		"source_url": "https://xtsupport.zendesk.com/api/v2/help_center/en-us/articles/61016521350809.json",
		"additional_sources": ["https://xtsupport.zendesk.com/hc/en-us/articles/61016521350809-XT-Announcement-on-the-Launch-of-Multiple-USDT-M-TradFi-Perpetual-Futures-2026-08-11"],
		"note": "XT官方上市公告Underlying Asset Tracked逐合约表明确列出03690.HK。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-announcement"
	},
	"xt:minimax_usdt": {
		"market": "HK",
		"reference": "00100.HK",
		"source_url": "https://xtsupport.zendesk.com/hc/en-us/articles/60134440041753-XT-Announcement-on-the-Launch-of-Multiple-USDT-M-TradFi-Perpetual-Futures-2026-07-17",
		"additional_sources": [],
		"note": "XT官方上市公告的Underlying Asset Tracked逐合约表明确标注HKEX证券代码。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-announcement"
	},
	"xt:pdd_usdt": {
		"market": "US",
		"reference": "NASDAQ:PDD",
		"source_url": "https://xtsupport.zendesk.com/api/v2/help_center/en-us/articles/61663969533465.json",
		"additional_sources": ["https://xtsupport.zendesk.com/hc/en-us/articles/61663969533465-XT-Announcement-on-the-Launch-of-Multiple-USDT-M-TradFi-Perpetual-Futures-2026-08-28"],
		"note": "XT官方上市公告Underlying Asset Tracked逐合约表明确列出NASDAQ:PDD。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-announcement"
	},
	"xt:popmart_usdt": {
		"market": "HK",
		"reference": "09992.HK",
		"source_url": "https://xtsupport.zendesk.com/api/v2/help_center/en-us/articles/60343679525017.json",
		"additional_sources": ["https://xtsupport.zendesk.com/hc/en-us/articles/60343679525017-XT-Announcement-on-the-Launch-of-Multiple-USDT-M-TradFi-Perpetual-Futures-2026-07-23"],
		"note": "XT官方上市公告Underlying Asset Tracked逐合约表明确列出09992.HK。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-announcement"
	},
	"xt:shein_usdt": {
		"market": "HK",
		"reference": "00625.HK",
		"source_url": "https://xtsupport.zendesk.com/api/v2/help_center/en-us/articles/61978109493145.json",
		"additional_sources": ["https://xtsupport.zendesk.com/hc/en-us/articles/61978109493145-XT-Announcement-on-the-Launch-of-Multiple-USDT-M-TradFi-Perpetual-Futures-2026-09-07"],
		"note": "XT官方上市公告Underlying Asset Tracked逐合约表明确列出00625.HK。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-announcement"
	},
	"xt:tencent_usdt": {
		"market": "HK",
		"reference": "00700.HK",
		"source_url": "https://xtsupport.zendesk.com/hc/en-us/articles/60134440041753-XT-Announcement-on-the-Launch-of-Multiple-USDT-M-TradFi-Perpetual-Futures-2026-07-17",
		"additional_sources": [],
		"note": "XT官方上市公告的Underlying Asset Tracked逐合约表明确标注HKEX证券代码。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-announcement"
	},
	"xt:zhipu_usdt": {
		"market": "HK",
		"reference": "02513.HK",
		"source_url": "https://xtsupport.zendesk.com/hc/en-us/articles/60134440041753-XT-Announcement-on-the-Launch-of-Multiple-USDT-M-TradFi-Perpetual-Futures-2026-07-17",
		"additional_sources": [],
		"note": "XT官方上市公告的Underlying Asset Tracked逐合约表明确标注HKEX证券代码。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-announcement"
	},
	"xt:zhongji_usdt": {
		"market": "HK",
		"reference": "03308.HK",
		"source_url": "https://xtsupport.zendesk.com/api/v2/help_center/en-us/articles/61122939244569.json",
		"additional_sources": ["https://xtsupport.zendesk.com/hc/en-us/articles/61122939244569-XT-Announcement-on-the-Launch-of-Multiple-USDT-M-TradFi-Perpetual-Futures-2026-08-14"],
		"note": "XT官方上市公告Underlying Asset Tracked逐合约表明确列出03308.HK。",
		"verified_at": "2026-09-11",
		"evidence_kind": "official-announcement"
	},
	"mexc:UNITREE_USDT": {
		"market": "A",
		"reference": "688836.SH",
		"source_url": "https://www.mexc.com/announcements/article/mexc-completes-conversion-of-unitree-robotics-unitree-pre-ipo-futures-to-standard-futures-17827791537670",
		"note": "2026-08-19官方完成转换公告：宇树688836.SH上市，UNITREE预IPO合约已转换为常规股票合约，链接精确UNITREE_USDT。",
		"verified_at": "2026-09-10T17:50:13.191465+00:00"
	},
	"mexc:CXMTSTOCK_USDT": {
		"market": "A",
		"reference": "688825.SH",
		"source_url": "https://www.mexc.com/futures/CXMTSTOCK_USDT",
		"note": "当前精确合约产品页说明：跟踪长鑫科技1股A股，上交所代码688825；CNH价格按USD/CNH转为USD。",
		"verified_at": "2026-09-10T17:50:13.191511+00:00"
	},
	"mexc:ZHONGJISTOCK_USDT": {
		"market": "HK",
		"reference": "03308.HK",
		"source_url": "https://www.mexc.com/announcements/article/mexc-to-list-zhongji-stock-futures-with-0-fee-trading-on-aug-14-17827791537552",
		"note": "2026-08-14官方上市公告列出ZHONGJI并链接精确合约，标的是ZHONGJI INNOLIGHT-H SHARES，HKEX3308。",
		"verified_at": "2026-09-10T17:50:13.191513+00:00"
	},
	"mexc:GIGADEVSTOCK_USDT": {
		"market": "HK",
		"reference": "03986.HK",
		"source_url": "https://www.mexc.com/announcements/article/mexc-to-list-gigadev-amgn-jmke-and-pep-stock-futures-with-0-fee-trading-on-aug-4-17827791537238",
		"note": "2026-08-04官方上市公告明确GigaDevice-H Shares，HKEX3986。",
		"verified_at": "2026-09-10T17:50:13.191515+00:00"
	},
	"mexc:ZHIPUSTOCK_USDT": {
		"market": "HK",
		"reference": "02513.HK",
		"source_url": "https://www.mexc.com/zh-TW/announcements/article/new-stock-futures-listings-17827791536396",
		"note": "2026-06-22官方上市公告明确智谱02513.HK为ZHIPUUSDT合约标的。",
		"verified_at": "2026-09-10T17:50:13.191516+00:00"
	},
	"mexc:MINIMAXSTOCK_USDT": {
		"market": "HK",
		"reference": "00100.HK",
		"source_url": "https://www.mexc.com/zh-MY/announcements/article/new-stock-futures-listings-17827791536358",
		"note": "2026-06-18官方公告说明跟踪MiniMax一股Class A普通股，香港股价HKD按USD/HKD换算；Class A为股权类别，不是中国A股。",
		"verified_at": "2026-09-10T17:50:13.191516+00:00"
	},
	"mexc:POPMARTSTOCK_USDT": {
		"market": "HK",
		"reference": "09992.HK",
		"source_url": "https://www.mexc.com/zh-MY/announcements/article/mexc-to-list-popmart-stock-futures-with-0-fee-trading-on-jul-23-17827791537011",
		"note": "2026-07-23官方上市公告明确Pop Mart International HKEX9992。",
		"verified_at": "2026-09-10T17:50:13.191517+00:00"
	},
	"mexc:KUAISHOUSTOCK_USDT": {
		"market": "HK",
		"reference": "01024.HK",
		"source_url": "https://www.mexc.com/en-GB/announcements/article/mexc-to-list-kuaishou-meituan-csopskhynix2l-and-csopsamsung2l-stock-futures-with-0-fee-trading-on-aug-11-17827791537452",
		"note": "官方上市公告：underlying asset KUAISHOU TECHNOLOGY HKEX1024；交易对链接精确KUAISHOUSTOCK_USDT。",
		"verified_at": "2026-09-10T17:50:13.191518+00:00"
	},
	"mexc:MEITUANSTOCK_USDT": {
		"market": "HK",
		"reference": "03690.HK",
		"source_url": "https://www.mexc.com/en-GB/announcements/article/mexc-to-list-kuaishou-meituan-csopskhynix2l-and-csopsamsung2l-stock-futures-with-0-fee-trading-on-aug-11-17827791537452",
		"note": "官方上市公告：underlying asset MEITUAN-W HKEX3690；交易对链接精确MEITUANSTOCK_USDT。",
		"verified_at": "2026-09-10T17:50:13.191519+00:00"
	},
	"mexc:HK0700_USDT": {
		"market": "HK",
		"reference": "00700.HK",
		"source_url": "https://www.mexc.com/en-GB/announcements/article/mexc-to-list-tencent-hk0700-xiaomi-and-mufg-stock-futures-with-0-fee-trading-on-jul-17-17827791536904",
		"note": "官方公告明确HK0700USDT Quanto跟踪腾讯HKEX700；HKD报价、USDT结算。",
		"verified_at": "2026-09-10T17:50:13.191520+00:00"
	},
	"mexc:BABASTOCK_USDT": {
		"market": "US",
		"reference": "BABA.NYSE",
		"source_url": "https://www.mexc.com/futures/BABASTOCK_USDT",
		"note": "MEXC精确合约产品页Crypto Name为BABAON，官方Website链接Ondo对应美国股票代币资产；采用美股上市线。",
		"verified_at": "2026-09-10T17:50:13.191522+00:00",
		"additional_sources": ["https://app.ondo.finance/assets/babaon"]
	},
	"mexc:BIDUSTOCK_USDT": {
		"market": "US",
		"reference": "BIDU.NASDAQ",
		"source_url": "https://www.mexc.com/futures/BIDUSTOCK_USDT",
		"note": "MEXC精确合约产品页Crypto Name为BIDUON，官方Website链接Ondo对应美国股票代币资产；采用美股上市线。",
		"verified_at": "2026-09-10T17:50:13.191524+00:00",
		"additional_sources": ["https://app.ondo.finance/assets/biduon"]
	},
	"mexc:FUTUSTOCK_USDT": {
		"market": "US",
		"reference": "FUTU.NASDAQ",
		"source_url": "https://www.mexc.com/futures/FUTUSTOCK_USDT",
		"note": "MEXC精确合约产品页Crypto Name为FUTUON，官方Website链接Ondo对应美国股票代币资产；采用美股上市线。",
		"verified_at": "2026-09-10T17:50:13.191526+00:00",
		"additional_sources": ["https://app.ondo.finance/assets/futuon"]
	},
	"mexc:JDSTOCK_USDT": {
		"market": "US",
		"reference": "JD.NASDAQ",
		"source_url": "https://www.mexc.com/futures/JDSTOCK_USDT",
		"note": "MEXC精确合约产品页Crypto Name为JDON，官方Website链接Ondo对应美国股票代币资产；采用美股上市线。",
		"verified_at": "2026-09-10T17:50:13.191527+00:00",
		"additional_sources": ["https://app.ondo.finance/assets/jdon"]
	},
	"mexc:PDDSTOCK_USDT": {
		"market": "US",
		"reference": "PDD.NASDAQ",
		"source_url": "https://www.mexc.com/futures/PDDSTOCK_USDT",
		"note": "MEXC精确合约产品页Crypto Name为PDDON，官方Website链接Ondo对应美国股票代币资产；采用美股上市线。",
		"verified_at": "2026-09-10T17:50:13.191529+00:00",
		"additional_sources": ["https://app.ondo.finance/assets/PDDon"]
	},
	"bitget:BABAUSDT": {
		"market": "US",
		"reference": "BABA.NYSE",
		"source_url": "https://www.bitget.com/support/articles/12560603846071",
		"note": "官方US Stock Futures活动在Eligibility中明确列出并链接该精确合约，确认美股上市线。",
		"verified_at": "2026-09-10T17:50:13.191531+00:00"
	},
	"bitget:FUTUUSDT": {
		"market": "US",
		"reference": "FUTU.NASDAQ",
		"source_url": "https://www.bitget.com/support/articles/12560603846071",
		"note": "官方US Stock Futures活动在Eligibility中明确列出并链接该精确合约，确认美股上市线。",
		"verified_at": "2026-09-10T17:50:13.191532+00:00"
	},
	"bitget:JDUSDT": {
		"market": "US",
		"reference": "JD.NASDAQ",
		"source_url": "https://www.bitget.com/support/articles/12560603846071",
		"note": "官方US Stock Futures活动在Eligibility中明确列出并链接该精确合约，确认美股上市线。",
		"verified_at": "2026-09-10T17:50:13.191534+00:00"
	},
	"bitget:MINIMAXHKDUSDT": {
		"market": "HK",
		"reference": "00100.HK",
		"source_url": "https://www.bitget.com/support/articles/12560603889791",
		"note": "官方该精确Quanto合约上市公告；跟踪港股本币HKD价格、以固定1:1换算进行USDT保证金及损益结算。",
		"verified_at": "2026-09-10T17:50:13.191535+00:00"
	},
	"bitget:XIAOMIHKDUSDT": {
		"market": "HK",
		"reference": "01810.HK",
		"source_url": "https://www.bitget.com/support/articles/12560603889934",
		"note": "官方该精确Quanto合约上市公告；跟踪港股本币HKD价格、以固定1:1换算进行USDT保证金及损益结算。",
		"verified_at": "2026-09-10T17:50:13.191536+00:00"
	},
	"bitget:TENCENTHKDUSDT": {
		"market": "HK",
		"reference": "00700.HK",
		"source_url": "https://www.bitget.com/support/articles/12560603889934",
		"note": "官方该精确Quanto合约上市公告；跟踪港股本币HKD价格、以固定1:1换算进行USDT保证金及损益结算。",
		"verified_at": "2026-09-10T17:50:13.191537+00:00"
	},
	"bitget:ZHIPUHKDUSDT": {
		"market": "HK",
		"reference": "02513.HK",
		"source_url": "https://www.bitget.com/support/articles/12560603889934",
		"note": "官方该精确Quanto合约上市公告；跟踪港股本币HKD价格、以固定1:1换算进行USDT保证金及损益结算。",
		"verified_at": "2026-09-10T17:50:13.191538+00:00"
	},
	"bitget:LENOVOHKDUSDT": {
		"market": "HK",
		"reference": "00992.HK",
		"source_url": "https://www.bitget.com/support/articles/12560603892215",
		"note": "官方该精确Quanto合约上市公告；跟踪港股本币HKD价格、以固定1:1换算进行USDT保证金及损益结算。",
		"verified_at": "2026-09-10T17:50:13.191538+00:00"
	},
	"bitget:SHEINHKDUSDT": {
		"market": "HK",
		"reference": "00625.HK",
		"source_url": "https://www.bitget.com/support/articles/12560603894080",
		"note": "官方该精确Quanto合约上市公告；跟踪港股本币HKD价格、以固定1:1换算进行USDT保证金及损益结算。",
		"verified_at": "2026-09-10T17:50:13.191539+00:00"
	},
	"bitget:KUAISHOUUSDT": {
		"market": "HK",
		"reference": "01024.HK",
		"source_url": "https://www.bitget.com/support/articles/12560603889221",
		"note": "精确合约官方上市公告说明Kuaishou于2021年在香港交易所主板上市。",
		"verified_at": "2026-09-10T17:50:13.191540+00:00"
	},
	"bitget:TENCENTUSDT": {
		"market": "HK",
		"reference": "00700.HK",
		"source_url": "https://web3.bitget.com/hot-trend-news/919",
		"note": "Bitget Wallet官方文章7 China stock perps now live明确称七个精确USDT合约为Hong Kong stock perps，逐项列出TENCENTUSDT；结合官方上市公告12560603887840确认精确合约。",
		"verified_at": "2026-09-10T17:51:22.801137+00:00"
	},
	"bitget:MEITUANUSDT": {
		"market": "HK",
		"reference": "03690.HK",
		"source_url": "https://web3.bitget.com/hot-trend-news/919",
		"note": "Bitget Wallet官方文章7 China stock perps now live明确称七个精确USDT合约为Hong Kong stock perps，逐项列出MEITUANUSDT；结合官方上市公告12560603887840确认精确合约。",
		"verified_at": "2026-09-10T17:51:22.801220+00:00"
	},
	"bitget:NETEASEUSDT": {
		"market": "HK",
		"reference": "09999.HK",
		"source_url": "https://web3.bitget.com/hot-trend-news/919",
		"note": "Bitget Wallet官方文章7 China stock perps now live明确称七个精确USDT合约为Hong Kong stock perps，逐项列出NETEASEUSDT；结合官方上市公告12560603887840确认精确合约。",
		"verified_at": "2026-09-10T17:51:22.801224+00:00"
	},
	"bitget:XIAOMIUSDT": {
		"market": "HK",
		"reference": "01810.HK",
		"source_url": "https://web3.bitget.com/hot-trend-news/919",
		"note": "Bitget Wallet官方文章7 China stock perps now live明确称七个精确USDT合约为Hong Kong stock perps，逐项列出XIAOMIUSDT；结合官方上市公告12560603887840确认精确合约。",
		"verified_at": "2026-09-10T17:51:22.801227+00:00"
	},
	"bitget:SMICUSDT": {
		"market": "HK",
		"reference": "00981.HK",
		"source_url": "https://web3.bitget.com/hot-trend-news/919",
		"note": "Bitget Wallet官方文章7 China stock perps now live明确称七个精确USDT合约为Hong Kong stock perps，逐项列出SMICUSDT；结合官方上市公告12560603887840确认精确合约。",
		"verified_at": "2026-09-10T17:51:22.801229+00:00"
	},
	"bitget:GIGADEVICEUSDT": {
		"market": "HK",
		"reference": "03986.HK",
		"source_url": "https://web3.bitget.com/hot-trend-news/919",
		"note": "Bitget Wallet官方文章7 China stock perps now live明确称七个精确USDT合约为Hong Kong stock perps，逐项列出GIGADEVICEUSDT；结合官方上市公告12560603887840确认精确合约。",
		"verified_at": "2026-09-10T17:51:22.801231+00:00"
	},
	"bitget:POPMARTUSDT": {
		"market": "HK",
		"reference": "09992.HK",
		"source_url": "https://web3.bitget.com/hot-trend-news/919",
		"note": "Bitget Wallet官方文章7 China stock perps now live明确称七个精确USDT合约为Hong Kong stock perps，逐项列出POPMARTUSDT；结合官方上市公告12560603887840确认精确合约。",
		"verified_at": "2026-09-10T17:51:22.801234+00:00"
	},
	"bitget:NIOUSDT": {
		"market": "US",
		"reference": "NIO.NYSE",
		"source_url": "https://www.bitget.com/news/detail/12560605406871",
		"note": "Bitget署名官方发布：2026-05-11上线六只美国股票perps，精确包含NIOUSDT；原合约公告12560603883697。",
		"verified_at": "2026-09-10T17:51:22.801236+00:00"
	},
	"mexc:HK1810_USDT": {
		"market": "HK",
		"reference": "01810.HK",
		"source_url": "https://www.mexc.com/en-GB/announcements/article/mexc-to-list-hk1810-lasertec-and-sumielec-stock-futures-with-0-fee-trading-on-jul-22-17827791536979",
		"note": "官方HK1810USDT公告明确underlying Xiaomi Corporation、HKEX港股HKD报价、USDT按1:1结算，表内链接精确HK1810_USDT。",
		"verified_at": "2026-09-10T17:51:22.801238+00:00"
	},
	"bitget:MINIMAXUSDT": {
		"market": "HK",
		"reference": "00100.HK",
		"source_url": "https://www.bitget.com/academy/quanto-perpetual-trade-without-fx-worries",
		"note": "Bitget官方Academy对比MINIMAXHKDUSDT和MINIMAXUSDT：后者跟踪MiniMax港股价格经HKD/USD换算后的USDT价格，示例明确HKD汇率对普通合约的影响。",
		"verified_at": "2026-09-10T17:52:56.777901+00:00"
	},
	"bitget:ZHIPUUSDT": {
		"market": "HK",
		"reference": "02513.HK",
		"source_url": "https://www.bitget.com/v1/mix/stock/querySymbolByType",
		"additional_sources": ["https://static.bgbstatic.com/mix/client/js/client-96d4916e.1d45f9838028df0d0f11.main.js", "https://www.bitget.com/support/articles/12560603887315"],
		"note": "Bitget公开合约关联API POST relationType=2,tickerType=[1,11,14]返回精确ZHIPUUSDT_UMCBL的tickerType=11；官网JS module555686定义1为US_STOCK、11为HK_STOCK、14为CN_STOCK。配合该精确合约上市公告核验公司，市场分类有直接接口证据。",
		"verified_at": "2026-09-10T17:55:19.070686+00:00",
		"source_request": {
			"method": "POST",
			"body": {
				"relationType": 2,
				"tickerType": [
					1,
					11,
					14
				]
			}
		},
		"observed_classification": {
			"relationType": 2,
			"showStatus": 1,
			"symbol": "ZHIPUUSDT_UMCBL",
			"tickerId": "1841",
			"tickerType": 11
		},
		"classification_enum": {
			"1": "US_STOCK",
			"11": "HK_STOCK",
			"14": "CN_STOCK"
		},
		"evidence_kind": "official-contract-equity-taxonomy"
	},
	"bitget:PDDUSDT": {
		"market": "US",
		"reference": "PDD.NASDAQ",
		"source_url": "https://www.bitget.com/v1/mix/stock/querySymbolByType",
		"additional_sources": ["https://static.bgbstatic.com/mix/client/js/client-96d4916e.1d45f9838028df0d0f11.main.js", "https://www.bitget.com/support/articles/12560603887644"],
		"note": "Bitget公开合约关联API POST relationType=2,tickerType=[1,11,14]返回精确PDDUSDT_UMCBL的tickerType=1；官网JS module555686定义1为US_STOCK、11为HK_STOCK、14为CN_STOCK。配合该精确合约上市公告核验公司，市场分类有直接接口证据。",
		"verified_at": "2026-09-10T17:55:19.070753+00:00",
		"source_request": {
			"method": "POST",
			"body": {
				"relationType": 2,
				"tickerType": [
					1,
					11,
					14
				]
			}
		},
		"observed_classification": {
			"relationType": 2,
			"showStatus": 1,
			"symbol": "PDDUSDT_UMCBL",
			"tickerId": "1155",
			"tickerType": 1
		},
		"classification_enum": {
			"1": "US_STOCK",
			"11": "HK_STOCK",
			"14": "CN_STOCK"
		},
		"evidence_kind": "official-contract-equity-taxonomy"
	},
	"bitget:ZHONGJIUSDT": {
		"market": "HK",
		"reference": "03308.HK",
		"source_url": "https://www.bitget.com/v1/mix/stock/querySymbolByType",
		"additional_sources": ["https://static.bgbstatic.com/mix/client/js/client-96d4916e.1d45f9838028df0d0f11.main.js", "https://www.bitget.com/support/articles/12560603892049"],
		"note": "Bitget公开合约关联API POST relationType=2,tickerType=[1,11,14]返回精确ZHONGJIUSDT_UMCBL的tickerType=11；官网JS module555686定义1为US_STOCK、11为HK_STOCK、14为CN_STOCK。配合该精确合约上市公告核验公司，市场分类有直接接口证据。",
		"verified_at": "2026-09-10T17:55:19.070757+00:00",
		"source_request": {
			"method": "POST",
			"body": {
				"relationType": 2,
				"tickerType": [
					1,
					11,
					14
				]
			}
		},
		"observed_classification": {
			"relationType": 2,
			"showStatus": 1,
			"symbol": "ZHONGJIUSDT_UMCBL",
			"tickerId": "1991",
			"tickerType": 11
		},
		"classification_enum": {
			"1": "US_STOCK",
			"11": "HK_STOCK",
			"14": "CN_STOCK"
		},
		"evidence_kind": "official-contract-equity-taxonomy"
	},
	"bitget:BYDUSDT": {
		"market": "HK",
		"reference": "01211.HK",
		"source_url": "https://www.bitget.com/v1/mix/stock/querySymbolByType",
		"additional_sources": ["https://static.bgbstatic.com/mix/client/js/client-96d4916e.1d45f9838028df0d0f11.main.js", "https://www.bitget.com/support/articles/12560603894613"],
		"note": "Bitget公开合约关联API POST relationType=2,tickerType=[1,11,14]返回精确BYDUSDT_UMCBL的tickerType=11；官网JS module555686定义1为US_STOCK、11为HK_STOCK、14为CN_STOCK。配合该精确合约上市公告核验公司，市场分类有直接接口证据。",
		"verified_at": "2026-09-10T17:55:19.070759+00:00",
		"source_request": {
			"method": "POST",
			"body": {
				"relationType": 2,
				"tickerType": [
					1,
					11,
					14
				]
			}
		},
		"observed_classification": {
			"relationType": 2,
			"showStatus": 0,
			"symbol": "BYDUSDT_UMCBL",
			"tickerId": "2502",
			"tickerType": 11
		},
		"classification_enum": {
			"1": "US_STOCK",
			"11": "HK_STOCK",
			"14": "CN_STOCK"
		},
		"evidence_kind": "official-contract-equity-taxonomy"
	},
	"bitget:CXMTUSDT": {
		"market": "A",
		"reference": "688825.SH",
		"source_url": "https://www.bitget.com/v1/mix/stock/querySymbolByType",
		"additional_sources": ["https://static.bgbstatic.com/mix/client/js/client-96d4916e.1d45f9838028df0d0f11.main.js", "https://www.bitget.com/support/articles/12560603892214"],
		"note": "Bitget公开合约关联API POST relationType=2,tickerType=[1,11,14]返回精确CXMTUSDT_UMCBL的tickerType=14；官网JS module555686定义1为US_STOCK、11为HK_STOCK、14为CN_STOCK。配合该精确合约上市公告核验公司，市场分类有直接接口证据。",
		"verified_at": "2026-09-10T17:55:19.070761+00:00",
		"source_request": {
			"method": "POST",
			"body": {
				"relationType": 2,
				"tickerType": [
					1,
					11,
					14
				]
			}
		},
		"observed_classification": {
			"relationType": 2,
			"showStatus": 1,
			"symbol": "CXMTUSDT_UMCBL",
			"tickerId": "2015",
			"tickerType": 14
		},
		"classification_enum": {
			"1": "US_STOCK",
			"11": "HK_STOCK",
			"14": "CN_STOCK"
		},
		"evidence_kind": "official-contract-equity-taxonomy"
	},
	"bitget:UNITREEUSDT": {
		"market": "A",
		"reference": "688836.SH",
		"source_url": "https://www.bitget.com/v1/mix/stock/querySymbolByType",
		"additional_sources": ["https://static.bgbstatic.com/mix/client/js/client-96d4916e.1d45f9838028df0d0f11.main.js", "https://www.bitget.com/support/articles/12560603892507"],
		"note": "Bitget公开合约关联API POST relationType=2,tickerType=[1,11,14]返回精确UNITREEUSDT_UMCBL的tickerType=14；官网JS module555686定义1为US_STOCK、11为HK_STOCK、14为CN_STOCK。配合该精确合约上市公告核验公司，市场分类有直接接口证据。",
		"verified_at": "2026-09-10T17:55:19.070763+00:00",
		"source_request": {
			"method": "POST",
			"body": {
				"relationType": 2,
				"tickerType": [
					1,
					11,
					14
				]
			}
		},
		"observed_classification": {
			"relationType": 2,
			"showStatus": 1,
			"symbol": "UNITREEUSDT_UMCBL",
			"tickerId": "2016",
			"tickerType": 14
		},
		"classification_enum": {
			"1": "US_STOCK",
			"11": "HK_STOCK",
			"14": "CN_STOCK"
		},
		"evidence_kind": "official-contract-equity-taxonomy"
	},
	"lighter:BABA": {
		"market": "UNKNOWN",
		"source_url": "https://docs.lighter.xyz/trading/real-world-assets-rwas/market-specifications",
		"verified_at": "2026-09-11",
		"exclude_from_monitor": true,
		"exclusion_reason": "官方资料仅确认阿里巴巴公司身份，未披露该合约的参考证券或预言机映射。",
		"note": "已复核官方规格、前端公司说明、market 177接口与上市公告；不能用BABA代码或价格接近代替NYSE ADS证据。",
		"additional_sources": ["https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails", "https://x.com/Lighter_xyz/status/2057896218064253206"]
	},
	"bitget:SHEINUSDT": {
		"market": "UNKNOWN",
		"source_url": "https://www.bitget.com/support/articles/12560603893862",
		"additional_sources": ["https://www.bitget.com/v1/mix/stock/querySymbolByType", "https://www.bitget.com/v1/mix/symbol/getContractSymbolListV3"],
		"verified_at": "2026-09-11",
		"exclude_from_monitor": true,
		"exclusion_reason": "上市线为港股00625.HK已确定（分类API tickerType=11），但8/31转换公告有开盘稳定条件，尚缺转换已完成的官方证据，不能将预计转换日当完成。",
		"note": "上市线为港股00625.HK已确定（分类API tickerType=11），但8/31转换公告有开盘稳定条件，尚缺转换已完成的官方证据，不能将预计转换日当完成。"
	},
	"mexc:SHEINSTOCK_USDT": {
		"market": "UNKNOWN",
		"source_url": "https://www.mexc.co/en-PH/announcements/article/mexc-to-convert-sheinusdt-pre-ipo-futures-into-standard-futures-17827791538008",
		"additional_sources": ["https://www.mexc.com/futures/SHEINSTOCK_USDT", "https://contract.mexc.com/api/v1/contract/detail"],
		"verified_at": "2026-09-11",
		"exclude_from_monitor": true,
		"exclusion_reason": "官方8/31公告拟9/1将00625.HK的Pre-IPO转换正式合约；实时目录已移出PreIPO区，但缺转换完成公告。preMarket=false不能作证明，因为OPENAI/ANTHROPIC也false。",
		"note": "官方8/31公告拟9/1将00625.HK的Pre-IPO转换正式合约；实时目录已移出PreIPO区，但缺转换完成公告。preMarket=false不能作证明，因为OPENAI/ANTHROPIC也false。"
	},
	"mexc:XIAOMISTOCK_USDT": {
		"market": "UNKNOWN",
		"source_url": "https://www.mexc.com/en-GB/announcements/article/mexc-to-list-tencent-hk0700-xiaomi-and-mufg-stock-futures-with-0-fee-trading-on-jul-17-17827791536904",
		"additional_sources": ["https://www.mexc.com/futures/XIAOMISTOCK_USDT", "https://contract.mexc.com/api/v1/contract/detail"],
		"verified_at": "2026-09-11",
		"exclude_from_monitor": true,
		"exclusion_reason": "精确合约公告/产品页仅公司简介；官方目录indexOrigin仅BITGET_FUTURE（其小米合约已核验HK），但尚无上游精确symbol关联，不能仅同名补齐。",
		"note": "精确合约公告/产品页仅公司简介；官方目录indexOrigin仅BITGET_FUTURE（其小米合约已核验HK），但尚无上游精确symbol关联，不能仅同名补齐。"
	},
	"mexc:NIOSTOCK_USDT": {
		"market": "UNKNOWN",
		"source_url": "https://www.mexc.com/announcements/article/new-stock-futures-listings-17827791536542",
		"additional_sources": ["https://www.mexc.com/futures/NIOSTOCK_USDT", "https://contract.mexc.com/api/v1/contract/detail"],
		"verified_at": "2026-09-11",
		"exclude_from_monitor": true,
		"exclusion_reason": "精确合约6/29上市公告和产品页仅NIO公司简介，缺明确NYSE/港股/新加坡上市线；indexOrigin含BITGET_FUTURE/PYTH/KAIKO但无上游精确symbol。",
		"note": "精确合约6/29上市公告和产品页仅NIO公司简介，缺明确NYSE/港股/新加坡上市线；indexOrigin含BITGET_FUTURE/PYTH/KAIKO但无上游精确symbol。"
	},
	"mexc:TENCENTSTOCK_USDT": {
		"market": "UNKNOWN",
		"source_url": "https://www.mexc.com/en-GB/announcements/article/mexc-to-list-tencent-hk0700-xiaomi-and-mufg-stock-futures-with-0-fee-trading-on-jul-17-17827791536904",
		"additional_sources": ["https://www.mexc.com/futures/TENCENTSTOCK_USDT", "https://contract.mexc.com/api/v1/contract/detail"],
		"verified_at": "2026-09-11",
		"exclude_from_monitor": true,
		"exclusion_reason": "精确普通USDT合约公告/产品页未注明上市线；同篇HK0700 Quanto为HK700不能自动套用。目录indexOrigin含BINANCE_FUTURE/BITGET_FUTURE但无上游symbol。",
		"note": "精确普通USDT合约公告/产品页未注明上市线；同篇HK0700 Quanto为HK700不能自动套用。目录indexOrigin含BINANCE_FUTURE/BITGET_FUTURE但无上游symbol。"
	},
	"xt:unitree_usdt": {
		"market": "UNKNOWN",
		"source_url": "https://xtsupport.zendesk.com/api/v2/help_center/en-us/articles/61309103223449.json",
		"additional_sources": [
			"https://xtsupport.zendesk.com/hc/en-us/articles/61309103223449",
			"https://fapi.xt.com/future/market/v1/public/symbol/list",
			"https://www.xt.com/fapi/market/v2/public/symbol/list",
			"https://www.xt.com/fapi/market/v1/public/symbol/detail?symbol=unitree_usdt",
			"https://www.xt.com/en/futures/trade/unitree_usdt"
		],
		"verified_at": "2026-09-11",
		"exclude_from_monitor": true,
		"exclusion_reason": "已读取XT官方8月19日上市公告全文与当前合约API，公告仅提供UNITREEUSDT名称、时间、杠杆，没有发行主体、证券代码、指数来源；暂无可靠逐合约锚定证据。未将公司已上市或同名ticker当作该合约已锚定A股的充分条件。",
		"note": "已读取XT官方8月19日上市公告全文与当前合约API，公告仅提供UNITREEUSDT名称、时间、杠杆，没有发行主体、证券代码、指数来源；暂无可靠逐合约锚定证据。未将公司已上市或同名ticker当作该合约已锚定A股的充分条件。"
	},
	"gate:KIMI_USDT": {
		"market": "PREIPO",
		"reference": "月之暗面上市前价格预期（发行后总股本假设 100 亿股；USDT 计价）",
		"source_url": "https://api.gateio.ws/api/v4/futures/usdt/contracts/KIMI_USDT",
		"additional_sources": ["https://www.gate.com/zh/announcements/article/100772", "https://www.gate.com/zh/price/moonshot-ai-%28kimi-ai%29-kimi"],
		"note": "官方合约 API 精确 KIMI_USDT 当前 is_pre_market=true、contract_type=stocks、status=trading。2026-07-21 活动公告明确 KIMIUSDT 为月之暗面盘前永续；官方产品介绍说明 Moonshot AI 尚未 IPO，合约进行上市前估值发现，假设发行后总股本 100 亿股。未转换为港股现货锚定。",
		"verified_at": "2026-09-10T17:59:54.473745+00:00",
		"evidence_kind": "official-preipo-product-and-current-contract"
	},
	"bitget:MOONSHOTUSDT": {
		"market": "PREIPO",
		"reference": "月之暗面上市前价格预期（估计总股本 10 亿股；USDT 结算）",
		"source_url": "https://www.bitget.com/support/articles/12560603891454",
		"additional_sources": ["https://www.bitget.com/academy/12560603892504", "https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES&symbol=MOONSHOTUSDT"],
		"note": "2026-08-07 精确 MOONSHOTUSDT 上市公告将其明确定义为 Moonshot AI Pre-IPO perpetual，表格列 estimated number of shares 为 1 billion。2026-08-19 官方产品指南仍将该合约列为预上市产品；当前 API symbolStatus=normal。未发现转为正式上市股票合约的公告。",
		"verified_at": "2026-09-10T17:59:54.473745+00:00",
		"evidence_kind": "official-preipo-product-and-current-contract"
	},
	"mexc:YMTCSTOCK_USDT": {
		"market": "PREIPO",
		"reference": "长江存储未来 1 股 A 股的上市前市场隐含价格（USD 计价）",
		"source_url": "https://www.mexc.com/announcements/article/first-in-market-17827791538145",
		"additional_sources": ["https://contract.mexc.com/api/v1/contract/detail?symbol=YMTCSTOCK_USDT", "https://www.mexc.com/futures/YMTCSTOCK_USDT"],
		"note": "2026-09-03 正式公告明确 YMTCUSDT 为 Pre-IPO 永续，参考 Yangtze Memory Technologies 未来 1 股普通 A 股的美元市场隐含价值，并说明并非上市后实际股价；公告交易链接精确指向 YMTCSTOCK_USDT。当前同名 API 合约 conceptPlate 含 mc-trade-zone-preipo，state=0。未来 A 股描述不能当作已经上市 A 股。",
		"verified_at": "2026-09-10T17:59:54.473745+00:00",
		"evidence_kind": "official-preipo-product-and-current-contract"
	},
	"mexc:KIMISTOCK_USDT": {
		"market": "PREIPO",
		"reference": "月之暗面未来 1 股港股的上市前价格预期（原规格假设总股本 100 亿股）",
		"source_url": "https://www.mexc.com/announcements/article/mexc-to-list-kimi-moonshot-ai-pre-ipo-futures-on-aug-6-2026-03-17827791537307",
		"additional_sources": [
			"https://contract.mexc.com/api/v1/contract/detail?symbol=KIMISTOCK_USDT",
			"https://www.mexc.com/announcements/product-updates",
			"https://www.mexc.com/learn/article/what-is-moonshotusdt-pre-ipo-futures-kimi-and-moonshot-ai-trading-explained/1"
		],
		"note": "2026-08-06 上市公告定义 KIMIUSDT 为月之暗面 Pre-IPO 永续、未来 1 股普通港股美元隐含价格，并假设发行后总股本 100 亿股；交易链接明确 KIMISTOCK_USDT。2026-08-11 更名公告把显示名改为 MOONSHOTUSDT、原持仓不受影响；当前 API symbol 仍为 KIMISTOCK_USDT、displayName 为 MOONSHOT_USDT、conceptPlate 含 preipo、state=0。该更名不是 IPO 转换。",
		"verified_at": "2026-09-10T17:59:54.473745+00:00",
		"evidence_kind": "official-preipo-product-and-current-contract"
	},
	"okx:MOONSHOT-USDT-SWAP": {
		"market": "PREIPO",
		"reference": "月之暗面上市前估值预期（1 MOONSHOT 对应估计总市值的十亿分之一）",
		"source_url": "https://www.okx.com/zh-hans/help/okx-to-list-pre-ipo-pre-market-perpetual-futures-for-moonshot-usdt",
		"additional_sources": ["https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=MOONSHOT-USDT-SWAP"],
		"note": "2026-08-17 正式公告将 MOONSHOT/USDT 明确定义为 Moonshot AI 的 Pre-IPO 盘前永续，估计股数 1,000,000,000；IPO 后才重基准并转换。当前精确 instId 的 ruleType=pre_market、state=live、preMktSwTime 为空，仍处预上市阶段。",
		"verified_at": "2026-09-10T17:59:54.473745+00:00",
		"evidence_kind": "official-preipo-product-and-current-contract"
	},
	"hyperliquid_xyz:xyz:YMTC": {
		"market": "UNKNOWN",
		"source_url": "https://docs.trade.xyz/perpetuals/specifications-and-schedules/pre-ipo-specification-index",
		"additional_sources": ["https://api.hyperliquid.xyz/info", "https://docs.trade.xyz/llms-full.txt"],
		"verified_at": "2026-09-10T17:59:54.473745+00:00",
		"exclude_from_monitor": true,
		"exclusion_reason": "官方 API 确认该市场已下架，当前规格已不收录；不作为可监控合约。",
		"note": "当前官方 metaAndAssetCtxs 明确 isDelisted=true、零持仓与零成交；但当前 XYZ Specification Index、Pre-IPO Specification Index 与完整官方文档 llms-full.txt 全文均无 YMTC，公开搜索也未找到该精确市场的原始官方 Pre-IPO 条款，不能仅凭公司未上市将该市场归为已核验预上市。保持下架/不可开仓状态。"
	}
};
//#endregion
//#region lib/visibility.ts
var monitorMarkets = [
	"A",
	"HK",
	"US",
	"PREIPO"
];
var evidence = share_class_evidence_default;
var shareLabels = {
	A: "A 股",
	HK: "港股",
	US: "美股 / ADR",
	PREIPO: "Pre-IPO",
	UNKNOWN: "锚定未确认",
	CONFLICT: "锚定有冲突"
};
var rowId = (r) => `${r.venue}:${r.symbol}`;
function contractEvidence(r) {
	return evidence[rowId(r)] ?? null;
}
function enrichContract(r) {
	const proof = contractEvidence(r);
	if (!proof) return r;
	return {
		...r,
		...proof.company_name ? { company_name: proof.company_name } : {},
		...monitorMarkets.includes(proof.market) ? { layer: marketSelection("all", proof.market).group } : {},
		anchor: `${shareLabels[proof.market]}${proof.reference ? " · " + proof.reference : ""}；${proof.note || "官方逐合约规格已核验"}`
	};
}
var enrichProviders = (providers) => providers.map((p) => ({
	...p,
	rows: p.rows.map(enrichContract)
}));
function marketSelection(group, market) {
	const nextMarket = typeof market === "string" && ["all", ...monitorMarkets].includes(market) ? market : "all";
	return {
		group: nextMarket === "US" ? "美股中概补充" : nextMarket === "PREIPO" ? "预上市补充" : nextMarket === "A" || nextMarket === "HK" ? "已上市公司" : typeof group === "string" && [
			"已上市公司",
			"美股中概补充",
			"预上市补充",
			"all"
		].includes(group) ? group : "已上市公司",
		market: nextMarket
	};
}
//#endregion
//#region publishing/snapshot.ts
var venues = seed_default.map((p) => p.venue);
function publicSnapshot(value) {
	const s = value;
	if (!s || !Array.isArray(s.providers) || s.providers.length !== venues.length || new Set(s.providers.map((p) => p.venue)).size !== venues.length || !s.providers.every((p) => venues.includes(p.venue) && Array.isArray(p.rows) && Number.isFinite(Date.parse(p.observedAt)) && p.rows.every((r) => r.venue === p.venue && typeof r.company_key === "string" && typeof r.symbol === "string"))) throw Error("Invalid market snapshot; publication stopped.");
	return {
		providers: enrichProviders(s.providers),
		events: Array.isArray(s.events) ? s.events.slice(0, 200) : [],
		watchlist: []
	};
}
//#endregion
//#region publishing/regional.ts
var regionalVenues = ["binance", "bybit"];
var regionalRegion = "ap-northeast-2";
var regionalEndpoint = "https://yvpgdnbcjgxpjqenhvuo.supabase.co/functions/v1/china-perp-collector?forceFunctionRegion=ap-northeast-2";
function validateRegional(value, responseRegion) {
	const payload = value;
	const providers = payload?.providers;
	if (responseRegion !== "ap-northeast-2" || payload?.region !== "ap-northeast-2" || !Array.isArray(providers) || providers.length !== regionalVenues.length || new Set(providers.map((p) => p.venue)).size !== regionalVenues.length || !providers.every((p) => regionalVenues.includes(p.venue) && Number.isFinite(Date.parse(p.observedAt)) && Array.isArray(p.rows) && p.rows.every((r) => r.venue === p.venue && typeof r.company_key === "string" && typeof r.symbol === "string"))) throw Error("Regional collector returned invalid data or an unexpected region");
	return providers;
}
//#endregion
//#region publishing/collect.ts
var siteOrigin = "https://china-perp-monitor.dovwooo.chatgpt.site";
async function previousSnapshot(url, bootstrap) {
	let failure;
	for (let attempt = 0; attempt < 3; attempt++) try {
		const response = await fetch(url, {
			cache: "no-store",
			signal: AbortSignal.timeout(2e4)
		});
		if (response.status === 404) return publicSnapshot(bootstrap);
		if (!response.ok) throw Error(`Previous publication HTTP ${response.status}`);
		return publicSnapshot(await response.json());
	} catch (error) {
		failure = error;
	}
	throw failure;
}
async function collectSnapshot(before) {
	const token = process.env.CHINA_PERP_COLLECTOR_TOKEN;
	const regionalTask = token ? (async () => {
		try {
			const response = await fetch(regionalEndpoint, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"x-region": regionalRegion
				},
				signal: AbortSignal.timeout(65e3)
			});
			if (!response.ok) throw Error(`Regional collector HTTP ${response.status}`);
			const providers = validateRegional(await response.json(), response.headers.get("x-sb-edge-region"));
			console.log(`Regional collector verified: ${regionalRegion}`);
			return {
				providers,
				error: null
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : "Request failed";
			console.log("Regional refresh unavailable:", message);
			return {
				providers: [],
				error: message
			};
		}
	})() : void 0;
	let hosted;
	try {
		const response = await fetch(`${siteOrigin}/api/monitor`, {
			method: "POST",
			headers: { Origin: siteOrigin },
			signal: AbortSignal.timeout(65e3)
		});
		if (!response.ok) throw Error(`HTTP ${response.status}`);
		const payload = await response.json();
		if (payload.storageError) throw Error("Hosted storage unavailable");
		hosted = publicSnapshot(payload);
	} catch (error) {
		console.log("Hosted refresh unavailable; using official exchange APIs.", error instanceof Error ? error.message : "Request failed");
	}
	const regional = await regionalTask;
	const providers = [...before.providers];
	let cursor = 0;
	await Promise.all(Array.from({ length: 3 }, async () => {
		while (cursor < providers.length) {
			const i = cursor++;
			const old = before.providers[i];
			if (regional && regionalVenues.includes(old.venue)) {
				const candidate = regional.providers.find((p) => p.venue === old.venue);
				providers[i] = candidate && Date.parse(candidate.observedAt) >= Date.parse(old.observedAt) ? candidate : {
					...old,
					attemptedAt: (/* @__PURE__ */ new Date()).toISOString(),
					error: regional.error || "区域采集返回旧数据，保留上次成功行情"
				};
				continue;
			}
			const candidate = hosted?.providers.find((p) => p.venue === old.venue);
			const base = candidate && Date.parse(candidate.observedAt) >= Date.parse(old.observedAt) ? candidate : old;
			providers[i] = candidate && !candidate.error && !stale(candidate.observedAt) && Date.parse(candidate.observedAt) >= Date.parse(old.observedAt) ? candidate : await refreshProvider(base, before.providers.flatMap((p) => p.rows));
		}
	}));
	const at = (/* @__PURE__ */ new Date()).toISOString();
	return {
		...publicSnapshot({
			providers,
			events: [...providers.flatMap((p, i) => changes(before.providers[i], p, at)), ...before.events]
		}),
		publishedAt: at
	};
}
async function main() {
	const [output, previousUrl] = process.argv.slice(2);
	if (!output || !previousUrl) throw Error("Usage: collect.mjs <monitor.json> <previous-public-url>");
	const next = await collectSnapshot(await previousSnapshot(previousUrl, publicSnapshot(JSON.parse(await readFile(output, "utf8")))));
	await writeFile(`${output}.tmp`, JSON.stringify(next));
	await rename(`${output}.tmp`, output);
	console.log(JSON.stringify({
		publishedAt: next.publishedAt,
		sources: next.providers.map((p) => ({
			venue: p.venue,
			error: p.error,
			quoteError: p.quoteError,
			observedAt: p.observedAt,
			oi: p.rows.filter((r) => r.oi != null).length,
			oiErrors: p.rows.filter((r) => r.oiError).length
		}))
	}));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
//#endregion
export { collectSnapshot, previousSnapshot, publicSnapshot };
