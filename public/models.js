// Task

var Task = Backbone.Model.extend({
	defaults: {
		text: "",
		excludedContexts: [], // context names
	},
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
});

var ComparisonCollection = Backbone.Collection.extend({
	model: Comparison,

	constructor: function (store) {
		store.applyToCollection(this);
		Backbone.Collection.apply(this, Array.prototype.slice.call(arguments, 1));
	},
});


// TaskForest

// TODO: use transitivity when a task is deleted
function TaskForest(tasks, comparisons) {
	this.tasks = tasks;
	this.comparisons = comparisons;

	this._recalculate();

	this.taskComparator = _.bind(this.taskComparator, this);

	this.listenTo(tasks, "add", this._addTask);
	this.listenTo(tasks, "remove reset", this._recalculate);

	this.listenTo(comparisons, "add", this._addComparison);
	this.listenTo(comparisons, "remove reset sort change", this._recalculate);
}
_.extend(TaskForest.prototype, Backbone.Events, {
	taskComparator: function (task1, task2) {
		var level1 = this._levels[task1.cid];
		var level2 = this._levels[task2.cid];
		if (level1 === undefined || level2 === undefined) {
			// console.error("during comparison, level for a task was unknown", task1, level1, task2, level2);
			return 0;
		}
		return level1 - level2;
	},

	_addTask: function (task) {
		this._children[task.cid] = [];
		this._parents[task.cid] = [];
		this._roots.push(task.cid);
		this._levels[task.cid] = 0;
		this.potentialNextTasks.push(task);
	},

	_addComparison: function (comparison) {
		// TODO: ignore edges that create cycles

		var greaterTask = this.tasks.get(comparison.get("greaterTaskId"));
		var lesserTask = this.tasks.get(comparison.get("lesserTaskId"));
		if (!greaterTask || !lesserTask) {
			return;
		}

		this._addChild(greaterTask.cid, lesserTask.cid);
		removeFromSet(this._roots, lesserTask.cid);

		this._walk(lesserTask, _.bind(function (task, level) {
			this._levels[task.cid] = level;
			return level + 1;
		}, this), this._levels[greaterTask.cid] + 1); // TODO: choose the max of its current level and this new level

		this.potentialNextTasks = _.filter(this.potentialNextTasks, function (task) {
			return task.cid !== lesserTask.cid;
		}, this)
	},

	_recalculate: function () {
		console.log("recalculate", this.tasks.length, this.comparisons.length);

		this._children = {}; // id -> [id, ...]
		this._parents = {}; // id -> [id, ...]
		this._roots = []; // to be filled in at the end
		this._levels = {}; // id -> level (0-indexed)
		this.potentialNextTasks = []; // [task, ...]

		console.time("calculate forest");

		this.tasks.each(this._addTask, this);
		this.comparisons.each(this._addComparison, this);

		console.timeEnd("calculate forest");

		this.trigger("recalculate");

		// this._walk(null, _.bind(function (task, indent) {
		// 	console.log(indent + task.get("text"));
		// 	return indent + " ";
		// }, this), "");
	},

	_addChild: function (parentCid, childCid) {
		addToSet(this._children[parentCid], childCid);
		addToSet(this._parents[childCid], parentCid);
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

	initialize: function () {
		if (this.has("id")) {
			this._makeCollections();
		} else {
			this.listenToOnce(this, "change:id", this._makeCollections);
		}
	},

	_makeCollections: function () {
		this.tasks = new TaskCollection(this.collection.store.makeStore("piles-" + this.id + "-tasks"));
		this.comparisons = new ComparisonCollection(this.collection.store.makeStore("piles-" + this.id + "-comparisons"));
		this.taskForest = new TaskForest(this.tasks, this.comparisons);

		this.tasks.comparator = this.taskForest.taskComparator;
		this.listenTo(this.taskForest, "recalculate", this._recalculated);
	},

	_recalculated: function () {
		this.tasks.sort();
	},
});

var PileCollection = Backbone.Collection.extend({
	model: Pile,

	constructor: function (store) {
		store.applyToCollection(this);
		Backbone.Collection.apply(this, Array.prototype.slice.call(arguments, 1));
	},
});
