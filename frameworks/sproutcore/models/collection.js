// ========================================================================
// SproutCore
// copyright 2006-2007 Sprout Systems, Inc.
// ========================================================================

require('models/record') ;
require('models/store') ;

// A collection holds a set of records matching the specified conditions. You
// can set the data source used to find the objects matching the conditions
// to create collections pulled from the local set of objects or pulled 
// from the server.
//
// Collection's automatically update their contents based on the conditions
// settings you provide as the state of loaded records change.
//
SC.Collection = SC.Object.extend({
  
  // ........................................
  // CONFIGURABLE PROPERTIES
  //
  // Set these properties to control the records that will be in this list.
  
  // indicates the keys to use to order the records.  If you want the records
  // ordered by descending order, use a string like 'guid DESC'.
  orderBy: ['guid'],

  // set this to the range of records you are interested in seeing or null if
  // you want to see all records.  Note that collection actually retrieves
  // a list of records slightly larger than what you pass here to allow for
  // members to be added and removed.
  offset: 0, limit: 0,
  
  // set this to a hash with conditions options. e.g. { active: true }.  If you
  // don't set this property, then all records of the given type will be
  // used.
  conditions: {},
  
  // this is the actual array of records in the current collection. This
  // property will change anytime the record members change (but not when
  // the member record properties change)
  records: function() {
    if (this._changedRecords) this._flushChangedRecords() ;
    return this._records ;
  }.property(),
  
  // the total count of records matching the conditions settings. The contents
  // of the records array will be clipped to the range value.
  count: function(key, value) {
    if (value !== undefined) {
      this._count = value ;
    } else if (this._changedRecords) this._flushChangedRecords() ;
    return this._count || 0 ;
  }.property(),

  // set to true when the collection is destroyed
  isDeleted: false, // RO
  
  // set this to the data source you want to use to get the records.  Use
  // either SC.Store or SC.Server.  If you use SC.Server, your recordType
  // must have a resourceURL property. // NC
  dataSource: SC.Store,
  
  // set this to the type of record you want in the collection.  This should
  // be set when the collection is created and not changed later.
  recordType: SC.Record, // NC

  // set to true while a refresh is in progress.
  isLoading: false, // RO
  
  // set to true if records have changed in a way that might leave the records out
  // of date.
  isDirty: false, // RO
  
  // ........................................
  // ACTIONS
  //

  // call this to force the list to refresh.  The refresh may not happen
  // right away, depending on the dataSource.
  refresh: function() {
    var recordType = this.get('recordType') || SC.Record ;
    var offset = (this._limit > 0) ? this._offset : 0 ;
    
    if (!this._boundRefreshFunc) {
      this._boundRefreshFunc = this._refreshDidComplete.bind(this) ;
    }    
    
    // start refresh
    if (!this.dataSource) throw "collection does not have dataSource" ;
    this.beginPropertyChanges();
    if (!this.isLoading) this.set('isLoading',true) ;
    this._refreshing = true ;
    
    var order = this.get('orderBy') ;
    if (order && !(order instanceof Array)) order = [order] ;
    this.dataSource.listFor({
      recordType: recordType,
      offset: offset, 
      limit: this._limit,
      conditions: this.get('conditions'), 
      order: order,
      callback: this._boundRefreshFunc,
      cacheCode: this._cacheCode
    }) ;
    this.endPropertyChanges() ;
    return this; 
  },
  
  // call this method when you are done with a collection.  This will remove
  // it as an observer to changes in the SC.Store so that it can be reclaimed.
  // isDeleted will also be set to true.
  destroy: function() { SC.Store.removeCollection(this); return this; },
  
  newRecord: function(settings) {
    if (!settings) settings = {} ;
    settings.newRecord = true ;
    settings.dataSource = this.get('dataSource') ;
    var ret = this.recordType.create(settings);
    SC.Store.addRecord(ret) ; // this will add the record to the collection.
    return ret;
  },
  
  // ........................................
  // INTERNAL
  //
  
  // this is the real offset, limit, and records used by the collection.
  // this can be a superset of the actual limits seen by outsiders.
  _offset: 0, _limit: 0, _records: null, _members: null, _store: null,
  
  init: function() {
    arguments.callee.base.call(this) ;
    SC.Store.addCollection(this) ; // get notified of changes.
    this._computeInteralOffsetAndLimit() ;
  },
  
  // This is the callback executed when the data source has found the records
  // matching the passed parameters.  The count is the total count of records
  // matching the conditions, ignoring the offset and limit.
  _refreshDidComplete: function(records,count,cacheCode) {
    if (cacheCode) this._cacheCode = cacheCode;

    if (records) {
      this.beginPropertyChanges() ;

      // update count
      if (this.get('count') != count) this.set('count',count) ;

      // update the record store and reslice.
      this.propertyWillChange('records') ;
      records = this._store = records.slice() ;
      this._reslice() ;
      this.propertyDidChange('records') ;

      this.endPropertyChanges();
    }
    
    this._refreshing = false ; // only one refresh at a time.
  },

  // called by SC.Store whenever an locally stored record has changed state.
  // This method simply indicates that the records property has changed and saved
  // the record for later processing.
  recordDidChange: function(rec) {
    if (!rec && !rec._guid) return ; // probably an error, but recover anyway.
    if (!this._changedRecords) this._changedRecords = {} ;
    this._changedRecords[rec._guid] = rec ;
    this.propertyWillChange('records') ;
    this.propertyDidChange('records') ;
    this.propertyWillChange('count') ;
    this.propertyDidChange('count') ;
  },

  // this method gets called just before the records property is returned.  If 
  // there are any changed records queued up, the record changes will be 
  // integrated.
  _flushChangedRecords: function() {
    if (!this._changedRecords) return ; // nothing to do.

    if (this.dataSource != SC.Store) throw "non-local data source is not supported"

    var current = this._store || [] ;
    var order = this.get('orderBy') || [this.recordType.primaryKey()] ;
    if (!(order instanceof Array)) order = [order] ;
    var conditions = this.get('conditions') ;

    // get the sorted set of changed records, both sorted and as a hash.
    var records = [] ;
    var changed = this._changedRecords ;
    for(var guid in changed) {
      if (!changed.hasOwnProperty(guid)) continue ;
      records.push(changed[guid]) ;
    }
    records = records.sort(function(a,b){ return a.compareTo(b,order); }) ;    
    this._changedRecords = null ;

    // step through the current set of records.  Interpolate changed records, remove records 
    // that don't belong.
    var loc = 0 ;
    while(loc < current.length)  {
      var working = current[loc] ;
      var compareToPrev, compareToNext ;
      
      // is this record one of the changed?
      // if so, then the record may need to be removed from its current position if it is deleted,
      // no longer belongs to the group, or is out of order.
      if (changed[working._guid]) {

        var belongs = (!working.get('isDeleted')) && working.matchConditions(conditions) ;
        if (belongs) {
          
          // comes after prev?
          if (loc>0) {
            belongs = (working.compareTo(current[loc-1],order) >= 0) ;
          }
          
          // comes before next?
          if (belongs && (loc+1 < current.length)) {
            belongs = (working.compareTo(current[loc+1],order) <= 0) ;
          }
        }
        if (!belongs) { current.splice(loc,1); continue; }
      }
      
      // if we get here, then the current record belongs where it is. next see if any of the changed
      // records need to be inserted here.
      var goAgain = true ;
      while ((records.length > 0) && goAgain) {
        var rec = records[0] ;
        if ((rec != working) && !rec.get('isDeleted') && rec.matchConditions(conditions)) {
          if ((rec == working) || (rec.compareTo(working,order) <= 0)) {
            if (rec != working) current.splice(loc,0,rec) ; // insert only if not the same. 
            loc++ ;
          } else goAgain = false ;
        }
        if (goAgain) records.shift() ;
      }
      
      // move on to the next record.
      loc++ ;
    }

    // if we get to the end and there are changed records left to process,
    // they probably need to be added.
    while(records.length > 0) {
      var rec = records.shift() ;
      if (!rec.get('isDeleted') && rec.matchConditions(conditions)) {
        current.push(rec) ;
      }
    }
        
//    if ((this == window.tphotos) && (current.length != this._count)) debugger ;
    
    // update the count as well.
    this._store = current ;
    this._count = current.length ;
    this._reslice() ;
  },
  
  /// SAVED FOR POSTERITY
  _oldRecordsDidChange: function() {
    var state = ((!rec.isDeleted) && rec.matchConditions(this.get('conditions'))) ? 'in' : 'out';
    var records = this._records ;
    
    // see if this comes before or after
    if ((this._limit > 0) && (state == "in") && records && (records.length > 0)) {
      var order = this.get('orderBy') ;
      if (rec.compareTo(records[0],order) < 0) {
        state = "before" ;
      } else if (rec.compareTo(records[records.length-1],order) > 0) {
        state = "after" ;
      }
    }
    
    // does this currently belong to the collection.
    var belongs = records.include(rec) ;
    var reslice = false ; var refresh = false ;
    
    // now adjust appropriately
    switch(state) {
      case 'before':
        // note: this is technically incorrect.  If the record comes before
        // that might actually shift everything forward. But there is no
        // way to really tell if the rec is just now being added or not.
        //
        // We let this go since this will only be temporarily wrong as the
        // list will get refreshed.
        //
        if (belongs) { records = records.without(rec) ;  reslice = true; }
        refresh = true ;
        break ;

      case 'after':
      case 'out':
        if (belongs) {
          records = records.without(rec) ;
          reslice = refresh = true ;
        }
        break ;
        
      case 'in':
        // resort records
        if (!belongs) {
          records = records.slice();
          records.push(rec) ;
        } 
        records = records.sort(function(a,b){ return a.compareTo(b,order); });
        if (!records.isEqual(this._records)) reslice = refresh = true ;
        break;
    }
    
    if (reslice) {
      this._records = records ;
      if (this._limit > 0) {
        var start = this.get('offset') - this._offset ;
        var end = start + this.get('limit') ;
        records = records.slice(start,end) ;
      }
      this.set('records',records) ;
    }
    
    //if (refresh && !this._refreshing) {
    //  this._refreshing = true ; var that = this ;
    //  setTimeout(function() { that.refresh(); },1) ;
    //}
  },
  
  // Anytime the properties used to filter the collection change, reslice if possible
  // then refresh from the data source.
  propertyObserver: function(observing,target,key,value) {
    if (target != this) return ;

    // update the internal properties then refresh.
    var needsRefresh = false ; 
    var nv ;
    value = this.get(key) ; 
    switch(key) {
      case 'offset':
      case 'limit':
        var oldOffset = this._offset ;
        var oldLimit = this._limit ;
        this._computeInteralOffsetAndLimit() ;
        if ((this._offset == oldOffset) && (this._limit == oldLimit)) {
          this.propertyWillChange('records') ;
          this._reslice();
          this.propertyDidChange('records') ;
        } else needsRefresh = true ;
        break ;
        
      case 'conditions':
      case 'orderBy':
        needsRefresh = true ;
        break ;
        
      default:
        break ;
    }

    // refresh only once per loop. We don't want to refresh multiple times
    // if the user makes changes to multiple settings.
    if (needsRefresh && !this._refreshing) {
      this._refreshing = true ;
      this._cacheCode = null ;
      this.set('isLoading',true) ; 
      setTimeout(this.refresh.bind(this),1);
    }
  },
  
  // using the current offset and limit properties, compute the internal offset and limit used for
  // records.
  _computeInteralOffsetAndLimit: function() {
    if (this.dataSource != SC.Store) {
      var v ;
      this._offset = ((v=this.get('offset')) > this.MARGIN) ? (v-this.MARGIN) : 0 ;
      this._limit = ((v=this.get('limit')) > 0) ? (v + this.MARGIN) : 0 ; 
    } else this._offset = this._limit = 0 ;
  },
  
  // This method will slice the _store records based on the current offset and limit.
  // Is it used internally and thus does not indicate that the computed records
  // property has changed.
  _reslice: function() {
    var offset = this.get('offset') ; 
    var limit = this.get('limit') ;
    if ((offset > 0) || (limit > 0)) {
      var start = offset - this._offset ;
      var end = start + ((limit <= 0) ? (this._store || []).length : limit) ;
      this._records = this._store.slice(start,end) ;
    } else this._records = this._store ;
  },
  
  MARGIN: 10
  
}) ;