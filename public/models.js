// Task

var Task = Backbone.Model.extend({
	defaults: {
		text: "",
		invalidated: false,
	},

	putOff: function (until) {
		this.save({
			waitingFor: until,
			waitingForSetAt: new Date,
		});
	},

	resume: function () {
		this.unset("waitingFor");
		this.unset("waitingForSetAt");
		this.save();
	},

	invalidate: function () {
		this.save({
			invalidated: true,
			invalidatedAt: new Date,
		});
	},
}, {
	timeScales: [
		{ id: "this-week",  label: "kinda soon", range: 7 * 24 * 60 * 60 * 1000 },
		{ id: "today",      label: "REALLY soon", range: 24 * 60 * 60 * 1000 },
	],
});

var TaskCollection = Backbone.Collection.extend({
	model: Task,

	constructor: function (store) {
		store.applyToCollection(this);
		Backbone.Collection.apply(this, Array.prototype.slice.call(arguments, 1));
	},
});


// Comparison

var Comparison = Backbone.Model.extend({
	defaults: {
		greaterTaskId: "",
		lesserTaskId: "",
		invalidated: false,
	},

	comparator: "createdAt",

	initialize: function () {
		if (!this.has("createdAt")) {
			this.set("createdAt", new Date);
		}
	},

	invalidate: function () {
		this.save({
			invalidated: true,
			invalidatedAt: new Date,
		});
	},
});

var ComparisonCollection = Backbone.Collection.extend({
	model: Comparison,

	constructor: function (store) {
		store.applyToCollection(this);
		Backbone.Collection.apply(this, Array.prototype.slice.call(arguments, 1));
	},
});


// TaskForest

function TaskForest(tasks, comparisons) {
	this.taskComparator = _.bind(this.taskComparator, this);

	this.tasks = tasks;
	this.comparisons = comparisons;

	this.potentialNextTasks = new Backbone.Collection();
	this.nextTasks = new Backbone.Collection();
	this.restTasks = new Backbone.Collection();
	this.wfTasks = new Backbone.Collection();
	this.potentialNextTasks.pile = this.nextTasks.pile = this.restTasks.pile = this.wfTasks.pile = this;

	this._recalculate();

	this.listenTo(tasks, "add remove reset change:waitingFor change:invalidated", atBatchEnd(this._recalculate, this));
	this.listenTo(comparisons, "add remove reset sort change:invalidated", atBatchEnd(this._recalculate, this));
}
_.extend(TaskForest.prototype, Backbone.Events, {
	randomComparisonTaskPair: function () {
		if (this.potentialNextTasks.length <= 2) {
			return _.shuffle(this.potentialNextTasks.slice(0, 2));
		}

		var self = this;

		return this.potentialNextTasks.chain().map(function (task) {
			return {
				task: task,
				weight: Math.random() / self._size[task.cid],
			};
		}).sortBy("weight").reverse().slice(0, 2).shuffle().pluck("task").value();
	},

	taskComparator: function (task1, task2) {
		var level1 = this._level(task1.cid);
		var level2 = this._level(task2.cid);

		if (level1 === undefined && level2 === undefined) {
			return 0;
		} else if (level1 === undefined) {
			return 1;
		} else if (level2 === undefined) {
			return -1;
		}

		if (level1 === level2) {
			return this._size[task2.cid] - this._size[task1.cid];
		}
		return level1 - level2;
	},

	_updateCollections: function () {
		var potentialNexts, nexts = {}, rests = {}, wfs = {}; // { cid: task, ... }
		var byLevel = []; // [{ cid: task, ... }, ...]
		var taskLevel = {}; // { cid: level, ... }

		function setLevel(task, level) {
			if (!(task.cid in taskLevel) || taskLevel[task.cid] < level) {
				if ((task.cid in taskLevel) && taskLevel[task.cid] < level) {
					var oldLevel = taskLevel[task.cid];
					delete byLevel[oldLevel][task.cid];
				}
				taskLevel[task.cid] = level;
				byLevel[level] || (byLevel[level] = {});
				byLevel[level][task.cid] = task;
			}
		}

		this._walk(null, function (task, level) {
			if (task.get("invalidated")) {
				return level;
			} else if (task.has("waitingFor")) {
				wfs[task.cid] = task;
				return level;
			} else {
				setLevel(task, level);
				return level + 1;
			}
		}, 0);

		for (var level = 0, next = true; byLevel[level]; level++) {
			var tasks = _.values(byLevel[level]);
			if (next && tasks.length === 1) {
				nexts[tasks[0].cid] = tasks[0];
			} else {
				potentialNexts = potentialNexts || byLevel[level];
				_.each(tasks, function (task) {
					rests[task.cid] = task;
				}, this);
				next = false;
			}
		}

		potentialNexts = potentialNexts || {};

		this.potentialNextTasks.reset(_.chain(potentialNexts).values().sortBy(this.taskComparator).value());
		this.nextTasks.reset(_.chain(nexts).values().sortBy(this.taskComparator).value());
		this.restTasks.reset(_.chain(rests).values().sortBy(this.taskComparator).value());
		this.wfTasks.reset(_.chain(wfs).values().sortBy(function (t) { return new Date(t.get("waitingForSetAt")) }).value());
	},

	_addTask: function (task) {
		this._children[task.cid] = [];
		this._parents[task.cid] = [];
		this._size[task.cid] = 1;
		this._roots.push(task.cid);
	},

	_addComparison: function (comparison) {
		if (comparison.get("invalidated")) {
			return;
		}

		var greaterTask = this.tasks.get(comparison.get("greaterTaskId"));
		var lesserTask = this.tasks.get(comparison.get("lesserTaskId"));
		if (!greaterTask || !lesserTask) {
			return;
		}

		if (_.contains(this._allParents(greaterTask.cid), lesserTask.cid)) {
			console.log("ignoring comparison that would create a cycle", greaterTask.get("text"), ">", lesserTask.get("text"));
			return;
		}

		this._addChild(greaterTask.cid, lesserTask.cid);
		removeFromSet(this._roots, lesserTask.cid);
		this._levelCache = {};
	},

	_recalculate: function () {
		this._children = {}; // cid -> [cid, ...]
		this._parents = {}; // cid -> [cid, ...]
		this._size = {}; // cid -> int
		this._roots = []; // [cid, ...]
		this._levelCache = {}; // cid -> int

		this.tasks.each(this._addTask, this);
		this.comparisons.each(this._addComparison, this);
		this._updateCollections();

		this.trigger("recalculate");
	},

	_addChild: function (parentCid, childCid) {
		addToSet(this._children[parentCid], childCid);
		addToSet(this._parents[childCid], parentCid);

		// XXX: not accurate because may have already been a child
		this._size[parentCid] += this._size[childCid];
		var parentParents = this._allParents(parentCid);
		_.each(parentParents, function (cid) {
			this._size[cid] += this._size[childCid];
		}, this);
	},

	_allParents: function (cid) {
		var self = this, all = [];
		walk(cid);
		return all;

		function walk(currentCid) {
			var parentCids = self._parents[currentCid] || [];
			all.push.apply(all, parentCids);
			_.each(parentCids, walk);
		}
	},

	// find the longest path to the root & return that depth
	_level: function (cid) {
		var self = this;
		return getLevel(cid);

		function getLevel(currentCid) {
			if (currentCid in self._levelCache) {
				return self._levelCache[currentCid];
			}

			var parentCids = self._parents[currentCid] || [];
			if (parentCids.length === 0) {
				return 0;
			}

			var level = _.max(parentCids.map(getLevel)) + 1;
			self._levelCache[currentCid] = level;
			return level;
		}
	},

	_walk: function (task, iter, data, filter) {
		// get the list of children in case it's mutated
		var children;
		if (task) {
			if (!this._children[task.cid]) {
				console.error("during walk, children of task weren't found", task);
				return;
			}
			children = this._children[task.cid];
		} else {
			children = this._roots;
		}

		// invoke the iterator
		if (task && (!filter || filter(task))) {
			data = iter(task, data);
		}

		// recurse
		_.each(children, function (childCid) {
			var child = this.tasks.get(childCid);
			if (child) {
				this._walk(child, iter, data, filter);
			} else {
				console.error("during walk, task wasn't found", childCid);
			}
		}, this);
	},
});


// Pile

var Pile = Backbone.Model.extend({
	defaults: {
		name: "",
	},

	loadCollections: function () {
		var storeID = this.get("storeID") || ("piles-" + this.id.toLowerCase());

		this.tasks = new TaskCollection(this.collection.store.makeStore(storeID, "tasks"));
		this.comparisons = new ComparisonCollection(this.collection.store.makeStore(storeID, "comparisons"));
		this.taskForest = new TaskForest(this.tasks, this.comparisons);

		this.tasks.pile = this.comparisons.pile = this;
	},

	toJSON: function () {
		var o = Backbone.Model.prototype.toJSON.apply(this, arguments);
		o.tasks = this.tasks.toJSON();
		o.comparisons = this.comparisons.toJSON();
		return o;
	},
});

var PileCollection = Backbone.Collection.extend({
	model: Pile,

	constructor: function (store) {
		store.applyToCollection(this);
		Backbone.Collection.apply(this, Array.prototype.slice.call(arguments, 1));
	},

	// per Backbone.js convention, that's an object, not a string
	clonePileFromJSON: function (json) {
		var d = new $.Deferred;

		var taskJSONs = json.tasks, comparisonJSONs = json.comparisons;
		var oldIds = _.pluck(taskJSONs, "id");
		delete json.id;
		delete json.tasks;
		delete json.comparisons;

		var pile = this.add(json);
		pile.save().then(saveTasks, bail("Could not save pile"));

		function saveTasks() {
			pile.loadCollections();
			pile.tasks.reset(_.map(taskJSONs, function (taskJSON) {
				delete taskJSON.id;
				return taskJSON;
			}));
			$.when.apply($, pile.tasks.invoke("save"))
				.then(saveComparisons, bail("failed to save all the tasks"));
		}

		function saveComparisons() {
			var newIds = pile.tasks.pluck("id");
			var idMap = _.object(oldIds, newIds);

			pile.comparisons.reset(_.reduce(comparisonJSONs, function (jsons, comparisonJSON) {
				delete comparisonJSON.id;
				comparisonJSON.lesserTaskId = idMap[comparisonJSON.lesserTaskId];
				comparisonJSON.greaterTaskId = idMap[comparisonJSON.greaterTaskId];
				if (comparisonJSON.lesserTaskId && comparisonJSON.greaterTaskId) {
					jsons.push(comparisonJSON);
				}
				return jsons;
			}, []));
			console.log("[import] pruned " + (comparisonJSONs.length - pile.comparisons.length) + " of " + comparisonJSONs.length + " comparisons");
			$.when.apply($, pile.comparisons.invoke("save"))
				.then(done, bail("failed to save all the comparisons"));
		}

		function done() {
			d.resolve(pile);
		}

		function bail(reason) {
			return function () {
				d.reject(reason);
			};
		}

		return d.promise();
	},
});
