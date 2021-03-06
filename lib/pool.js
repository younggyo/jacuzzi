'use strict'

var debug   = require('debug')('jacuzzi:pool')
var utils   = require('./utils')
var Promise = global.Promise

module.exports = /** @lends Pool */ {

  initialize: function(name, opts, args) {
    this.name      = name
    this.opts      = validateOptions(opts)
    this.opts.args = args
    this.pool      = []
    this.size      = 0
    this.free      = this.opts.max
    this.timer     = []
    this.queue     = []
    this.draining  = false
    this.pending   = []
    this.pending.scope = []
    this.pending.count = { '': 0 }
    this.requested     = { '': 0 }
    this.resourceIndex = 0
    this.refill()
    delete this.initialize
  },

  possible: function(scope, includeRequests) {
    if (!scope) scope = ''
    var max = this.opts.scope[scope]
    var cur = this.pending.count[scope] || 0
    if (includeRequests) {
      cur += this.requested[scope] || 0
    }
    return !max || cur < max
  },

  /**
   * Acquire a resource from the pool.
   *
   * @param {Pool~acquire} [callback] An optional callback that
   *        gets called once a resource is ready.
   * @returns {Promise} It additionally returns a `Promise`, which can be used
   *        instead of the `callback`.
   * @public
   */
  acquire: function(scope, callback) {
    if (typeof scope === 'function') {
      callback = scope
      scope = undefined
    }

    if (!scope) {
      scope = ''
    }

    if (this.draining) {
      throw new Error('Cannot acquire from a pool that got shut down')
    }

    this.debug('requesting resource ' + scope)

    var self = this, stopped = false

    function acquire(prepend) {
      if (stopped) return null

      // get a resource
      return new Promise(function(resolve) {
        var possible = self.possible(scope, true)

        // count current scope requests
        self.requested[scope] = (self.requested[scope] || 0) + 1

        if (possible && self.pool.length) {
          var resource = self.pool.shift()

          self.debug('requesting resource: resource available')
          // check the resource
          resolve(self.checkResource(resource))
        }
        // create new resource
        else if (possible && self.size < self.opts.max) {
          resolve(self.createResource(self.opts.errorTolerance))
        }
        // if there is no available resource, queue this request and try to
        // refill the pool
        else {
          self.queue[prepend ? 'unshift' : 'push']({
            callback: resolve, scope: scope
          })
          self.debug('requesting resource: resource unavailable - request queued')
          self.refill()
        }
      })

      // return resource
      .then(function(resource) {
        // if the resource is `null`, the check failed, retry process
        if (!resource) {
          self.debug('requesting resource: retry')
          // `true` indicates to add this request to the first position in
          // the queue (instead of normally enqueueing it)
          return acquire(true)
        }

        self.pending.push(resource)
        self.pending.scope.push(scope)
        self.requested[scope]--
        self.pending.count[scope] = (self.pending.count[scope] || 0) + 1
        self.debug('requesting resource: done')

        // set the timer for possible resource leak detection
        if (self.opts.leakDetectionThreshold > 0) {
          self.timer.push(setTimeout(function() {
            console.error('Possible resource leak detected. ' +
                          'Resource not released within %ds',
                          self.opts.leakDetectionThreshold / 1000)
            console.trace()
          }, self.opts.leakDetectionThreshold))
        }

        // finalize Promise
        return resource
      })
    }

    return utils.callbackify(utils.timeout(
      acquire(false),
      self.opts.acquisitionTimeout,
      'Acquiring resource timed out'
    ), callback)

    .catch(function(err) {
      self.requested[scope]--
      stopped = true
      return Promise.reject(err)
    })
  },

  /**
   * @callback Pool~acquire
   * @param {Error} err
   * @param {Resource} resource
   */

  /**
   * Return a resource back into the pool.
   *
   * @param {Resource} resource The resource being returned.
   * @returns {Boolean}
   * @api public
   */
  release: function(resource, remove) {
    // check if the resource released is a resource the pool is waiting for
    var idx
    if ((idx = this.pending.indexOf(resource)) === -1) {
      return false
    }

    // remove from list of pending resources and clear the leak detection timer
    this.pending.splice(idx, 1)
    var scope = this.pending.scope.splice(idx, 1)[0]
    this.pending.count[scope]--
    clearTimeout(this.timer.splice(idx, 1)[0])

    this.debug('releasing resource ^ ' + scope)

    if (remove || this.size > this.opts.max) {
      this.destroyResource(resource)
    } else {
      this.return(resource)
    }

    return true
  },

  /**
   * Refills the pool according to `opts.min` and `opts.max`.
   *
   * @api private
   */
  refill: function() {
    if (this.draining) return

    // create at least `opts.min` resources
    if (this.size < this.opts.min) {
      for (var i = this.size; i < this.opts.min; ++i) {
        this.createResource(true)
            .then(this.return.bind(this), this.throw.bind(this))
      }
    }

    // if `opts.max` is not yet reached look for waiting requests and provide
    // them with resources
    for (var j = 0, len = this.queue.length; this.size < this.opts.max && j < len; ++j) {
      var scope = this.queue[j].scope
      if (!scope || this.possible(scope, true)) {
        this.createResource()
            .then(this.return.bind(this), this.throw.bind(this))
      }
    }
  },

  /**
   * Create a new resource and add it to the pool.
   *
   * @fires Pool#create
   * @fires Pool#fail
   * @param {Number} [attempt] The attempt counter increases the delay on
   *         failure or timeout.
   * @api private
   */
  createResource: function(retry, attempt) {
    // if (this.size >= this.opts.max) {
    //   return Promise.reject(new Error('Cannot create more resources - maximum ' +
    //                                   'pool size already reached'))
    // }

    this.debug('creating resource')

    this.size++
    this.free--

    var self = this

    var fn = this.opts.create.bind.apply(
      this.opts.create,
      [null].concat(this.opts.args)
    )

    return utils.timeout(
      utils.promisify(fn),
      self.opts.creationTimeout,
      'Creating resource timed out'
    )

    // initialize resource
    .then(function(resource) {
      if (!resource) {
        throw new Error('Create failed')
      }

      // add id
      resource.name = self.name + ':' + self.resourceIndex++;

      // add event listeners
      if (typeof resource.on === 'function') {
        self.opts.events.forEach(function(event) {
          resource.on(event, function callback() {
            resource.removeListener(event, callback)
            if (self.pool.indexOf(resource) === -1) return
            self.destroyResource(resource)
          })
        })
      }

      self.debug('creating resource: succeeded')

      /**
       * Create event.
       *
       * @event Pool#create
       * @type {Resource}
       */
      process.nextTick(function() {
        self.emit('create', resource)
      })

      return resource
    })

    // if the creating fails, retry it (with an increasing backoff)
    .catch(function(err) {
      self.debug('creating resource: failed')

      if (err) {
        self.debug(err)
        self.debug(err.stack)
      }

      self.emit('fail', err)

      if (!retry || self.draining) {
        self.size--
        self.free++
        return Promise.reject(err)
      }

      var delay = utils.backoff(attempt || 1)
      self.debug('creating resource: trying again with ' + delay + 'ms backoff')

      setTimeout(function() {
        self.size--
        self.free++
        self.createResource(true, attempt && ++attempt || 2)
      }, delay)
    })
  },

  /**
   * Destroy a resource and remove it from the pool.
   *
   * @fires Pool#destroy
   * @fires Pool#fail
   * @param {Resource} resource The resource to be destroyed.
   * @api private
   */
  destroyResource: function(resource) {
    // if the resource is currently inside the pool, remove it
    var idx
    if ((idx = this.pool.indexOf(resource)) > -1) {
      this.pool.splice(idx, 1)
    }

    this.debug('destroying resource')

    var self = this

    // destroy the resource
    new Promise(function(resolve) {
      if (!self.opts.destroy) return resolve()

      resolve(utils.timeout(
        utils.promisify(self.opts.destroy.bind(null, resource)),
        self.opts.destructionTimeout,
        'Destroying resource timed out'
      ))
    })

    // dispose resource
    .then(function() {
      self.size--
      self.free++
      self.debug('resource successfully destroyed')

      /**
       * Destroy event.
       *
       * @event Pool#destroy
       * @type {Resource}
       */
      process.nextTick(function() {
        self.emit('destroy', resource)
      })
    })

    // if the destruction fails, remove it anyway ...
    .catch(function(err) {
      self.size--
      self.free++
      self.debug('destroying resource failed - removing it anyway')

      if (err) {
        self.debug(err)
        self.debug(err.stack)
      }

      self.emit('fail', err)
    })

    // finalize
    .then(function() {
      self.refill()
    })
  },

  /**
   * Check a resource and destroy it on failure.
   *
   * @fires Pool#fail
   * @param {Resource} resource The resource to be checked.
   * @api private
   */
  checkResource: function(resource) {
    // if there is no `opts.check` function provided, succeed the check
    if (!this.opts.check) {
      return Promise.resolve(resource)
    }

    this.debug('checking resource')

    var self = this

    // call `opts.check`
    return utils.promisify(this.opts.check.bind(null, resource))

    // evaluate the result
    .then(function(result) {
      if (result) {
        self.debug('checking resource: passed')
        return resource
      }
      else {
        self.debug('checking resource: failed')
        self.destroyResource(resource)
        return null
      }
    })

    // on error destroy resource
    .catch(function(err) {
      self.destroyResource(resource)
      self.debug('checking resource: errored')

      if (err) {
        self.debug(err)
        self.debug(err.stack)
      }

      self.emit('fail', err)
    })
  },

  /**
   * Gracefully shut down the pool. Let it drain ...
   *
   * @api public
   */
  drain: function() {
    this.debug('draining pool')

    this.draining = true
    var resource
    while((resource = this.pool.shift())) {
      this.destroyResource(resource)
    }

    this.pool.push = this.destroyResource.bind(this)
  },

  debug: function(msg) {
    debug('[%s] ∑:%d q:%d s:%d α:%d ' + msg, this.name, this.size,
          this.pool.length, this.pending.length, this.queue.length)
  },

  return: function(resource) {
    this.debug('returning resource')

    // if there are requests waiting with a resource, feed them
    if (this.queue.length) {
      for (var i = 0, len = this.queue.length; i < len; ++i) {
        var scope = this.queue[i].scope
        if (!this.possible(scope)) {
          continue
        }

        this.debug('returning resource - forwarding resource')
        var resolve = this.queue.splice(i, 1)[0].callback
        resolve(resource)
        return
      }
    }

    // otherweise, add the resource to the pool
    this.pool.push(resource)
    this.debug('returning resource - resource returned into pool')
  },

  throw: function(err) {
    throw err
  }
}

/**
 * Fail event.
 *
 * @event Pool#fail
 * @type {Error}
 */

/**
 * @typedef PoolOptions
 * @type {Object}
 * @property {String} [name] a name for the pool - useful for debugging purposes
 * @property {Number} min=2 minimum number of active resources in pool at any
 *           given time
 * @property {Number} max=10 maximum number of concurrently active resources
 * @property {Pool~create} create a function that creates new resources
 * @property {Pool~destroy} [destroy] a function that is used to destroy resources
 * @property {Pool~check} [check] a function that is used to check a resource
 * @property {Array.<String>} events=['close', 'end', 'error', 'timeout'] a list
 *           of events that are listened to on each resource and - if called -
 *           lead to the destruction of the resource
 * @property {Number} creationTimeout=500 a timeout (in ms) for the creation of
 *           a resource
 * @property {Number} destructionTimeout=500 a timeout (in ms) for the
 *           destruction of a resource
 * @property {Number} acquisitionTimeout=10000 a timeout (in ms) for the
 *           acquisition of a resource
 * @property {Number} leakDetectionThreshold=30000 an amount of time that a
 *           resource can be in use out of the pool before a error is thrown
 *           indicating a possible resource leak. (0 = disabled)
 * @property {Boolean} errorTolerance=true whether failures while creating
 *           resources should be ignored and the creation retried or the errors
 *           returned and creation aborted
 */

var defaultOpts = {
  min: 2,
  max: 10,
  scope: {},
  events: ['close', 'end', 'error', 'timeout'],
  creationTimeout: 2000,
  destructionTimeout: 500,
  acquisitionTimeout: 10000,
  leakDetectionThreshold: 30000,
  errorTolerance: true,
}

function validateOptions(opts) {
  ['min', 'max', 'creationTimeout', 'destructionTimeout', 'acquisitionTimeout', 'leakDetectionThreshold'].forEach(function(prop) {
    if (typeof opts[prop] !== 'number' || opts[prop] < 0) {
      delete opts[prop]
    }
  })

  if (opts.max < 1) {
    delete opts.max
  }

  if (typeof opts.scope !== 'object') {
    opts.scope = {}
  }

  if (typeof opts.create !== 'function') {
    throw new TypeError('`opts.create` must be a function')
  }

  if (opts.destroy && typeof opts.destroy !== 'function') {
    throw new TypeError('`opts.destroy` must be a function')
  }

  if (opts.check && typeof opts.check !== 'function') {
    throw new TypeError('`opts.check` must be a function')
  }

  var merged = utils.extend({}, defaultOpts, opts)
  if (merged.min > merged.max) {
    merged.max = merged.min
  }

  return merged
}

/**
 * Resource
 * @name Resource
 */

/**
 * Create
 * @method Pool~create
 * @param {...*} args
 * @param {Function} [callback]
 * @returns {Resource|Promise}
 */

/**
 * Destroy
 * @method Pool~destroy
 * @param {Resource} resource
 * @param {Function} [callback]
 * @returns {?Promise}
 */

/**
 * Check
 * @method Pool~check
 * @param {Resource} resource
 * @param {Function} [callback]
 * @returns {Boolean|Promise}
 */