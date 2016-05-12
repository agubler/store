import Query from './Query';
import { Patch, diff, createPatch } from '../patch/Patch';
import filterFactory, { Filter } from './Filter';
import Promise from 'dojo-shim/Promise';
import Map from 'dojo-shim/Map';
import { after } from 'dojo-core/aspect';
import request, { Response, RequestOptions } from 'dojo-core/request';
import Evented from 'dojo-core/Evented';
import { Sort, sortFactory } from './Sort';
import { StoreRange, rangeFactory } from './Range';
import { QueryType } from './Query';
import { Handle, EventObject } from 'dojo-core/interfaces';
import { duplicate } from 'dojo-core/lang';
import { Transaction, SimpleTransaction, batchUpdates } from './Transaction';

export type UpdateType = 'add' | 'update' | 'delete' | 'batch';

export interface Update<T> extends  EventObject {
	type: UpdateType;
}

export interface BatchUpdate<T> extends Update<T> {
	updates: Update<T>[]
}

export interface ItemAdded<T> extends Update<T> {
	item: T;
	index?: number;
}

export interface ItemUpdated<T> extends Update<T> {
	item: T;
	diff: () => Patch;
	index?: number;
	previousIndex?: number;
}

export interface ItemDeleted extends Update<any> {
	id: string;
	index?: number;
}

export type ItemMap<T> = { [ index: string ]: { item: T, index: number } };
export type SubscriberObj<T> = { onUpdate(updates: Update<T>[]): void}
export type Subscriber<T> = { onUpdate(updates: Update<T>[]): void; } | ((updates: Update<T>[]) => void);

function isFilter<T>(filterOrTest: Query<T> | ((item: T) => boolean)): filterOrTest is Filter<T> {
	return typeof filterOrTest !== 'function' && (<Query<T>> filterOrTest).queryType === QueryType.Filter;
}

function isSort<T>(sortOrComparator: Sort<T> | ((a: T, b: T) => number)): sortOrComparator is Sort<T> {
	return typeof sortOrComparator !== 'function';
}

function isRange(query: Query<any>): query is Range<any> {
	return query.queryType === QueryType.Range;
}

function isSubscriberObj<T>(subscriber: Subscriber<T>): subscriber is SubscriberObj<T> {
	return Boolean((<any> subscriber).onUpdate);
}

export interface Store<T> extends Evented {
	get(...ids: string[]): Promise<T[]>;
	getIds(...items: T[]): string[];
	generateId(): Promise<string>;
	add(...items: T[]): Promise<T[]>;
	put(...items: T[]): Promise<T[]>;
	put(...updates: Map<string, Patch>[]): Promise<T[]>;
	delete(...ids: string[]): Promise<string[]>;
	release(): Promise<any>;
	track(): Promise<any>;
	fetch(...queries: Query<T>[]): Promise<T[]>;
	filter(filter: Filter<T>): Store<T>;
	filter(test: (item: T) => boolean): Store<T>;
	getUpdateCallbck(): () => void;
	createFilter(): Filter<T>;
	range(range: StoreRange<T>): Store<T>;
	range(start: number, count: number): Store<T>;
	sort(sort: Sort<T> | ((a: T, b: T) => number) | string, descending?: boolean): Store<T>;
	transaction(): void;
}

export interface StoreOptions<T, U extends Store<T>> {
	source?: U;
	queries?: Query<T>[];
}
export interface MemoryOptions<T, U extends Store<T>> extends StoreOptions<T, U> {
	data?: T[];
	map?: ItemMap<T>;
	version?: number;
}

export interface RequestStoreOptions<T, U extends Store<T>> extends StoreOptions<T, U> {
	target: string;
	filterSerializer?: (filter: Filter<T>) => string;
	sendPatches?: boolean;
}


export abstract class BaseStore<T, U extends BaseStore<T>> implements Store<T> {
	protected source: U;
	protected sourceHandles: Handle[];
	protected queries: Query<T>[];
	protected StoreClass: new (...args: any[]) => Store<T>;
	protected subscribers: Subscriber<T>[];
	protected getBeforePut: boolean;
	protected map: ItemMap<T>;
	protected data: T[];
	protected version: number;
	protected isLive: boolean;
	protected inTransaction: boolean;
	protected pendingOperations: (() => void)[];

	constructor(options?: StoreOptions<T, U>) {
		options = options || {};
		this.source = options.source;
		this.queries = options.queries || [];
		this.StoreClass = <any> this.constructor;
		this.subscribers = [];
		this.getBeforePut = true;
		this.version = this.source ? this.source.version : 1;
		this.inTransaction = false;
		this.setupUpdateAspects();
	}

	abstract getIds(...items: T[]): string[];
	abstract generateId(): Promise<string>;
	abstract createFilter(): Filter<T>;

	protected abstract _fetch(...queries: Query<T>[]): Promise<T[]>;
	protected abstract _get(...ids: string[]): Promise<T[]>;
	protected abstract _put(...itemsOrPatches: (T | Map<string, Patch>)[]): Promise<ItemUpdated<T>[]>;
	protected abstract _add(items: T[], indices?: number[]): Promise<ItemAdded<T>[]>;
	protected abstract _delete(ids: string[], index: number[]): Promise<ItemDeleted[]>;
	protected abstract handleUpdates(updates: Update<T>[]): void;
	protected abstract isUpdate(item: T): Promise<boolean>;

	release(): Promise<any> {
		if (this.source) {
			if (this.sourceHandles) {
				this.sourceHandles.forEach(handle => handle.destroy());
				this.sourceHandles = [];
			}
			return this.fetch().then(function(data) {
				this.data = duplicate(data);
				this.source = null;
				this.isLive = false;
				return this.data;
			}.bind(this));
		} else {
			return Promise.resolve();
		}
	}

	track(): Promise<Store<T>> {
		if (this.source) {
			this.sourceHandles = [
				this.source.on('batch', this.propagateUpdate.bind(this)),
				this.source.on('add', this.propagateUpdate.bind(this)),
				this.source.on('update', this.propagateUpdate.bind(this)),
				this.source.on('delete', this.propagateUpdate.bind(this))
			];
		}

		this.isLive = true;
		return this.fetch().then(function() {
			return this;
		});
	}

	transaction() {
		this.inTransaction = true;
		return new SimpleTransaction<T>(this);
	}

	get(...ids: string[]) {
		if (this.source) {
			return this.source.get(...ids);
		} else {
			return this._get(...ids);
		}
	}

	put(...itemsOrPatches: (T[] | Map<string, Patch>)[]) {
		if (this.source) {
			return this.source.put(itemsOrPatches);
		} else {
			if (typeof this.version !== 'undefined') {
				this.version++;
			}

			const areItems = itemsOrPatches.length && itemsOrPatches[0].toString() !== 'Map';
			if (!areItems) {
				return this._put(itemsOrPatches);
			} else {
				let transaction: Transaction<T, U> = this.transaction();
				return Promise.all(batchUpdates<U, () => Promise<T[]>(this, itemsOrPatches.map(function(itemOrPatch): Promise<T[]> {
					return () => {
						let promise:Promise<any>;
						if (areItems) {
							promise = this.isUpdate(<T> itemOrPatch);
						} else {
							promise = Promise.resolve(itemOrPatch);
						}

						return promise.then(function (isUpdate:any): Promise<T[]> {
							if (isUpdate) {
								return this._put(itemOrPatch).then(function (results: ItemUpdated<T>[]) {
									return results.map(function(result) {
										return result.item;
									});
								});
							} else {
								return this._add(<T> itemOrPatch).then(function (results: ItemAdded<T>[]) {
									return results.map(function(result) {
										return result.item;
									});
								});
							}
						});
					};
				}))).then(function(itemArrays: T[][]) {
					return itemArrays.reduce((prev, next) => [ ...prev, ...next ]);
				});
			}
		}
	}

	add(...items: T[]) {
		if (this.source) {
			return this.source.add(items);
		} else {
			if (typeof this.version !== 'undefined') {
				this.version++;
			}
			return this._add(...items).then(function(results) {
				return results.map(function(result) {
					return result.item;
				});
			});
		}
	}

	delete(...ids: string[]) {
		if (this.source) {
			return this.source.delete(...ids);
		} else {
			if (typeof this.version !== 'undefined') {
				this.version++;
			}
			return this._delete(...ids).then(function(results: ItemDeleted[]) {
				return results.map(function(result) {
					return result.id;
				});
			});
		}
	}

	fetch(queries?: Query<T>[]) {
		if (this.source && (typeof this.version === 'undefined' || this.version !== this.source.version)) {
			return this.source.fetch(this.queries).then(function(fullData: T[]) {
				this.version = this.source.version;
				this.data = this.queries.reduce((prev: T[], next: Query<T>) => next.apply(prev), fullData);
				if (this.isLive) {
					return this.buildMap(this.data).then(function(map) {
						this.map = map;
						return this.data;
					});
				} else {
					return this.data;
				}
			}.bind(this));
		} else {
			return this._fetch(queries);
		}
	}

	filter(filterOrTest: Filter<T> | ((item: T) => boolean)) {
		let filter: Filter<T>;
		if (isFilter(filterOrTest)) {
			filter = filterOrTest;
		} else {
			filter = this.createFilter().custom(filterOrTest);
		}

		return this.query(filter);
	}

	range(rangeOrStart: StoreRange<T> | number, count?: number) {
		let range: StoreRange<T>;
		if (typeof count !== 'undefined') {
			range = rangeFactory<T>(<number> rangeOrStart, count);
		} else {
			range = <StoreRange<T>> rangeOrStart;
		}

		return this.query(range);
	}

	sort(sortOrComparator: Sort<T> | ((a: T, b: T) => number), descending?: boolean) {
		let sort: Sort<T>;
		if (isSort(sortOrComparator)) {
			sort = sortOrComparator;
		} else {
			sort = sortFactory(sortOrComparator, descending);
		}

		return this.query(sort);
	}

	protected query(query: Query<T>) {
		const options: StoreOptions<T, U> = this.getOptions();
		options.queries = [ ...(options.queries || []), query ];

		return this.createSubcollection(options);
	}

	protected createSubcollection(options: StoreOptions<T, U>): U {
		return <U> new this.StoreClass(options);
	}

	protected setupUpdateAspects(): void {
		const unwrapUpdates = function(updatePromises: Promise<Update<T>[]>) {
			updatePromises.then(this.handleUpdates.bind(this));
		}.bind(this);

		this._put = after(this._put, unwrapUpdates);
		this._add = after(this._add, unwrapUpdates);
		this._delete = after(this._delete, unwrapUpdates);
	}

	protected propagateUpdate(eventOrEvents: Update<T>): void {
		const events: Update<T>[] = (<BatchUpdate<T>> eventOrEvents).updates || [ eventOrEvents ];

		if (typeof this.version !== 'undefined') {
			this.version++;
		}
		this.version += events.length;
		events.forEach(function(event) {
            switch (event.type) {
                case 'add':
                    this._add((<ItemAdded<T>> event).item);
                    break;
                case 'update':
                    this._put((<ItemUpdated<T>> event).item);
                    break;
                case 'delete':
                    this._delete((<ItemDeleted<T>> event).id);
                    break;
            }
		}, this);
	}

	getUpdateCallback() {
		return this.propagateUpdate.bind(this);
	}

	protected buildMap(collection: T[], map?: ItemMap<T>): Promise<{ [ index: string ]: { item: T, index: number } }> {
		const self = this;
		const _map = map || <ItemMap<T>> {};
		return Promise.resolve(this.getIds(...collection).map(function(id, index) {
			if (_map[id] && !map) {
				throw new Error('Collection contains item with duplicate ID');
			}
			return _map[id] = { item: collection[index], index: index };
		}));
	}

	protected getOptions(): StoreOptions<T, U> {
		return {
			source: this.source || this,
			queries: this.queries
		};
	}
}

export class MemoryStore<T> extends BaseStore<T, MemoryStore<T>> {

	constructor(options?: MemoryOptions<T, MemoryStore<T>>) {
		super();
		this.data = options.data || [];
		if (!this.source) {
			this.map = options.map || {};
			this.buildMap(this.data, this.map);
		}
	}

	_get(...ids: string[]): Promise<T[]> {
		return Promise.resolve(ids.map(function(id: string) {
			return duplicate(this.map[id].item);
		}))
	}

	_put(itemsOrPatches: (T | Map<string, Patch>)[]): Promise<ItemUpdated<T>[]> {
		const self = this;
		const areItems = itemsOrPatches[0] && itemsOrPatches[0].toString() !== 'Map';
		let updates: ItemUpdated<T>[];
		const hasRangeQuery = (this.source && this.queries.some(isRange));
		if (areItems) {
			updates = (<T[]> itemsOrPatches).map(function(item) {
				const id = this.getIds(item)[0];
				const mapEntry = this.map[id];
				const oldItem = mapEntry.item;
				const oldIndex = mapEntry.index;
				const _diff = () => diff(oldItem, item);

				this.data[mapEntry.index] = item;
				return <ItemUpdated<T>> {
					item: item,
					oldINdex: oldIndex,
					diff: _diff,
					type: 'update'
				};
			}, this)
		} else {
			const patchMap: Map<string, Patch> = (<Map<string, Patch>[]> itemsOrPatches).reduce((prev, next: Map<string, Patch>) => {
				next.keys().forEach(function(key) {
					if (prev.has(key)) {
						prev.put(key, createPatch([ ...prev.get(key).operations, ...next.get(key).operations ]));
					} else {
						prev.put(key, next.get(key));
					}
				});
				return prev;
			}, new Map<string, Patch>());

			updates = patchMap.keys().map(function(id) {
				const mapEntry = this.map[id];
				const oldIndex: number = mapEntry.index;
				const patch = patchMap.get(id);
				const item:T = hasRangeQuery ? this.source.map.get(id).item : patch.apply(mapEntry.item);
				const _diff = () =>  patchMap.get(id);

				this.data[mapEntry.index] = mapEntry.item = item;
				return <ItemUpdated<T>> {
					item: item,
					oldIndex: oldIndex,
					diff: _diff,
					type: 'update'
				};
			}, this);
		}

		let newData: Promise<T[]>;
		if (hasRangeQuery) {
			newData = this.source.fetch(this.queries)
		} else {
			newData = this._fetch(this.queries);
		}
		return newData.then(function(data: T[]) {
			self.data = data;
			return this.buildMap(this.data).then(function(map) {
				self.map = map;
				return updates.map(function(update) {
					const id = self.getId(update.item);
					if (map.has(id) {
						update.index = map.get(id).index;
					}
					return update
				}, self);
			})
		});
	}

	createFilter() {
		return filterFactory<T>();
	}

	getId(item: T) {
		return Promise.resolve((<any> item).id);
	}

	generateId() {
		return Promise.resolve('' + Math.random());
	}

	_add(item: T, index?: number): Promise<ItemAdded<T>> {
		return this.getId(item).then(function(id) {
			if (this.map[id]) {
				throw new Error('Item added to collection item with duplicate ID');
			}
			this.collection.push(item);
			this.map[id] = { item: item, index: this.collection.length - 1};

			return {
				item: this.map[id].item,
				index: this.map[id].index,
				type: 'add'
			};
		});
	}

	_getOptions(): MemoryOptions<T, MemoryStore<T>> {
		return {
			version: this.version
		};
	}

	_delete(id: string, index?: number): Promise<ItemDeleted> {
		this.version++;
		const mapEntry = this.map[id];
		delete this.map[id];
		this.collection.splice(mapEntry.index, 1);
		this.buildMap(this.collection.slice(mapEntry.index), this.map);

		return Promise.resolve({
			id: id,
			index: mapEntry.index,
			type: 'delete'
		});
	}

	handleUpdates(updates: Update<T>[]) {
	}

	_isUpdate(item: T) {
		return this.getId(item).then(function(id: string) {
			return this.map[id];
		}.bind(this));
	}

	_fetch(...queries: Query<T>[]) {
		return Promise.resolve(this.queries.reduce((prev, next) => next.apply(prev), this.data));
	}
}

export class RequestStore<T> extends BaseStore<T, RequestStore<T>> {
	private target: string;
	private filterSerializer: (filter: Filter<T>) => string;
	private sendPatches: boolean;

	constructor(options: RequestStoreOptions<T, RequestStore<T>>) {
		super();
		this.target = options.target;
		this.filterSerializer = options.filterSerializer;
		this.sendPatches = Boolean(options.sendPatches);
	}

	createFilter() {
		return filterFactory(this.filterSerializer);
	}

	fetch(): Promise<T[]> {
		const filterString = this.queries.reduce((prev: Filter<T>, next: Query<T>) => {
			if (isFilter(next)) {
				return prev ? prev.and(next) : next;
			} else {
				return prev;
			}
		}, null).toString();
		return request.get(this.target + '?' + filterString).then(function(response: Response<string>) {
			return JSON.parse(response.data);
		});
	}

	getId(item: T): Promise<string> {
		return Promise.resolve((<any> item).id);
	}

	generateId(): Promise<string> {
		return Promise.resolve('' + Math.random());
	}

	protected _get(id: string): Promise<T> {
		return Promise.resolve(null);
	}

	protected _put(itemOrId: String|T, patch?: Patch): Promise<ItemUpdated<T>> {
		let idPromise: Promise<string> = (patch ? Promise.resolve(<string> itemOrId) : this.getId(<T> itemOrId));
		return idPromise.then(function(id: string) {
			let requestOptions: RequestOptions;
			if (patch && this.sendPatches) {
				requestOptions = {
					method: 'patch',
					data: patch.toString(),
					headers: {
						'Content-Type': 'application/json'
					}
				};
			} else {
				requestOptions = {
					method: 'put',
					data: JSON.stringify(itemOrId),
					headers: {
						'Content-Type': 'application/json'
					}
				};
			}
			return request<string>(this.target + id, requestOptions).then(function(response) {
				const item = JSON.parse(response.data);
				const oldItem: T = patch ? null : <T> itemOrId;
				return {
					item: item,
					type: UpdateType.Updated,
					diff: () => patch ? patch : diff(oldItem, item)
				};
			});
		}.bind(this));
	}

	protected _add(item: T, index?: number): Promise<ItemAdded<T>> {
		return request.post<string>(this.target, {
			data: JSON.stringify(item),
			headers: {
				'Content-Type': 'application/json'
			}
		}).then(function(response) {
			return {
				item: JSON.parse(response.data),
				type: UpdateType.Added
			};
		});
	}

	protected _getOptions(): RequestStoreOptions<T, RequestStore<T>> {
		return {
			target: this.target,
			filterSerializer: this.filterSerializer,
			sendPatches: this.sendPatches
		};
	}

	protected _delete(id: string, index?: number): Promise<ItemDeleted> {
		return  Promise.resolve({
			id: id,
			index: index,
			type: UpdateType.Deleted
		});
	}

	protected _handleUpdate(update: Update<T>): void {
	}

	protected _isUpdate(item: T): Promise<boolean> {
		return Promise.resolve(false);
	}

}