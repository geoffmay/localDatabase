Mutex = require('async-mutex');

const lDB = (function () {


    var lDB = {};

    // static variables
    lDB.databaseName = 'default';
    lDB.openTimeoutMilliseconds = 1 * 60 * 1000;
    lDB.closeTimeoutMilliseconds = 30 * 60 * 1000;

    // lDB.isDatabaseOpen = false;
    lDB._numberOfPendingRequests = 0;
    lDB._pendingVersionChange = 0;
    lDB._pendingMutexLock = new Mutex.Mutex();
    lDB._numberOfActiveReaders = 0;
    lDB._activeMutexLock = new Mutex.Mutex();
    lDB._closingDbName = '';

    // static functions
    lDB.addAndHandleCollection = function (objectStoreName, objectToAdd, handlerCallback) {
        lDB._incrementActiveReaders();
        var promise = new Promise((resolve, reject) => {
            addPromise = lDB._addToObjectStore(objectStoreName, objectToAdd);
            addPromise.then(() => {
                lDB._readObjectStore(objectStoreName, undefined, handlerCallback)
                    .then(objectStore => {
                        lDB._decrementActiveReaders();
                        resolve(objectStore);
                    });
            });
        });
        return promise;
    }

    lDB.addAndLogCollection = function (objectStoreName, objectToAdd) {
        var callback = function (objectStore) {
            console.log(objectStore);
        }
        addPromise = lDB.addAndHandleCollection(objectStoreName, objectToAdd, callback);
        return addPromise;
    }


    lDB._pollPendingRequests = function () {
        var _pollPending = function () {
            if (!lDB._pendingVersionChange > 0) {
                return lDB._numberOfPendingRequests;
            }
            else {
                return 999;
            }
        }
        return lDB._pendingMutexLock.runExclusive(_pollPending);
    }
    lDB._incrementPendingRequests = function () {
        var _increment = function () {
            lDB._numberOfPendingRequests++;
            if (!lDB._pendingVersionChange > 0) {
                return lDB._numberOfPendingRequests;
            }
            else {
                return 999;
            }
        }
        return lDB._pendingMutexLock.runExclusive(_increment);
    }
    lDB._incrementPendingVersionChange = function () {
        var _incrementV = function () {
            lDB._pendingVersionChange++;
            return lDB._pendingVersionChange;
        }
        return lDB._pendingMutexLock.runExclusive(_incrementV);
    }
    lDB._decrementPendingVersionChange = function () {
        var _decrementV = function () {
            lDB._pendingVersionChange--;
            return lDB._pendingVersionChange;
        }
        return lDB._pendingMutexLock.runExclusive(_decrementV);
    }

    lDB._decrementPendingRequests = function () {
        var _decrement = function () {
            lDB._numberOfPendingRequests--;
            return lDB._numberOfPendingRequests;
        }
        return lDB._pendingMutexLock.runExclusive(_decrement);
    }
    lDB._pollActiveReaders = function () {
        var _pollActive = function () {
            return lDB._numberOfActiveReaders;
        }
        return lDB._activeMutexLock.runExclusive(_pollActive);
    }
    lDB._incrementActiveReaders = function () {
        var _increment = function () {
            lDB._numberOfActiveReaders++;
            return lDB._numberOfActiveReaders;
        }
        return lDB._activeMutexLock.runExclusive(_increment);
    }
    lDB._decrementActiveReaders = function () {
        var _decrement = function () {
            lDB._numberOfActiveReaders--;
            if (lDB._numberOfActiveReaders == 0) {
                lDB._closeDatabase();
            }
            return lDB._numberOfActiveReaders;
        }
        return lDB._activeMutexLock.runExclusive(_decrement);
    }


    lDB._addToObjectStore = function (objectStoreName, objectToAdd) {
        return new Promise((resolveAddObject, rejectAddObject) => {
            this._ensureDatabaseHasObjectStore(objectStoreName).then(() => {

                // var __addTransaction = function (resolveAddObject, rejectAddObject) {
                var transaction = lDB.activeDb.transaction([objectStoreName], "readwrite");
                // transaction.oncomplete = function (event) {
                //     /* doesn't need to be handled per se */
                // };
                transaction.onerror = function (event) { rejectAddObject(event); };
                var objectStore = transaction.objectStore(objectStoreName);
                var objectStoreRequest = objectStore.add(objectToAdd);
                objectStoreRequest.onsuccess = function (event) {
                    resolveAddObject(event);
                };
                objectStoreRequest.onerror = function (event) { rejectAddObject(event); }
                // }
            });

        });



        //         lDB._ensureDesiredDatabaseIsOpen().then(() => {
        //             if (!lDB.__hasObjectStore(objectStoreName)) {
        //                 lDB._createObjectStore(objectStoreName).then(() => {
        //                     lDB._addToObjectStore(objectStoreName, objectToAdd).then(() => {
        //                         resolveAddObject();
        //                     });
        //                 });
        //             }
        //             else {
        //             }
        //         });
        //     });
        //     return addPromise;
        // }
    }


    lDB._readObjectStore = function (objectStoreName, key, storeHandlerFunction) {
        var promise = new Promise((resolve, reject) => {
            lDB._ensureDatabaseHasObjectStore(objectStoreName).then(() => {

                var transaction = lDB.activeDb.transaction([objectStoreName], "readonly");

                transaction.onerror = function (event) { reject(event); };
                var objectStore = transaction.objectStore(objectStoreName);
                var objectStoreRequest;

                // Get all objects if a key is not defined
                if (key !== undefined) { objectStoreRequest = objectStore.get(key); }
                else { objectStoreRequest = objectStore.getAll(); }

                objectStoreRequest.onsuccess = function (event) {
                    lDB.objectStore = {
                        name: objectStoreName,
                        contents: event.target.result
                    };
                    // use the custom handler function if one was given
                    if (storeHandlerFunction !== undefined) { storeHandlerFunction(lDB.objectStore); }
                    resolve(lDB.objectStore);
                };
                objectStoreRequest.onerror = function (event) {
                    reject(event);
                }
            });
        });
        return promise;
    }



    lDB._createObjectStore = function (name, attributesObject) {
        if (name === undefined) {
            name = 'default';
        }
        if (attributesObject === undefined) {
            attributesObject = { autoIncrement: true };
        }
        var promise = new Promise((resolve, reject) => {
            lDB._ensureDesiredDatabaseIsOpen().then(() => {
                if (!lDB.__hasObjectStore(name)) {
                    var nextVersion = lDB.activeDb.version + 1;
                    // if (lDB.activeDb !== undefined) { // should never happen now after mutex lock was implemented...?
                    if (lDB.activeDb === undefined) {
                        throw ('database was unexpectedly undefined');
                    }
                    closeRequest = lDB._closeDatabase();
                    closeRequest.then(() => {
                        var versionChangeCallback = function (event) {
                            var db = event.target.result;
                            db.onerror = function (event) { reject(event); };
                            var objectStore = db.createObjectStore(name, attributesObject);

                            // you can manipulate the new object store directly here (and only  here), 
                            // perhaps via attributes that are specially named

                            objectStore.transaction.oncomplete = function (event) {
                                lDB.activeDb = event.target.db;
                                lDB._decrementPendingVersionChange().then(() => {
                                    resolve(lDB.activeDb);
                                });
                            }
                        }
                        lDB._closingDbName = '';
                        lDB._openDatabase(nextVersion, versionChangeCallback);
                    });
                }
                else { // object store already exists
                    // todo: make sure it has the same attributes
                    resolve(lDB.activeDb);
                }
            });
        })
        return promise;
    }

    lDB.deleteObjectStore = function (name) {
        if (name === undefined) {
            throw ('you must define a name');
        }
        var promise = new Promise((resolve, reject) => {
            lDB._ensureDesiredDatabaseIsOpen().then(() => {
                if (lDB.__hasObjectStore(name)) {
                    var nextVersion = lDB.activeDb.version + 1;
                    var __versionChangeCallback = function (event) {
                        var db = event.target.result;
                        db.onerror = function (event) {
                            reject(event);
                        };
                        var objectStore = db.deleteObjectStore(name);
                        // there is no transaction here(?) so objectStore remains undefined
                        // we can wait for the onsuccess event of the open request though
                        lDB.activeDb = db;
                        lDB._decrementPendingVersionChange().then(() => {
                            resolve(lDB.activeDb);
                        });
                    }
                    if (lDB.activeDb !== undefined) {
                        lDB.activeDb.close();
                    }
                    lDB._closingDbName = '';
                    lDB._openDatabase(nextVersion, __versionChangeCallback);
                }
                else {
                    // object store did not exist (we could reject here but it would need to be handled)
                    resolve(lDB.activeDb);
                }
            });
        })
        return promise;
    }

    lDB.__hasObjectStore = function (objectStoreName) {
        var names = Array.from(lDB.activeDb.objectStoreNames);
        for (let i = 0; i < names.length; i++) {
            if (names[i] === objectStoreName) {
                return true;
            }
        }
        return false;
    }


    lDB._ensureDatabaseHasObjectStore = function (objectStoreName) {
        return new Promise(resolve => {
            lDB._ensureDesiredDatabaseIsOpen().then(() => {
                if (lDB.__hasObjectStore(objectStoreName)) {
                    resolve();
                }
                else {
                    lDB._createObjectStore(objectStoreName).then(() => {
                        resolve();
                    });
                }
            });
        });
    }
    // });


    // if (!lDB._isDesiredDatabaseOpen()) {
    //     lDB._ensureDesiredDatabaseIsOpen()
    //         .then(() => { return lDB.__hasObjectStore(objectStoreName); });
    // }
    // else {
    // }
    // }

    lDB._ensureDesiredDatabaseIsOpen = function () {
        var promise = new Promise((resolve) => {
            if (lDB._isDesiredDatabaseOpen()) {
                resolve(lDB.activeDb);
            }
            else {
                lDB._openDatabase()
                    .then((db) => { resolve(db); })
            }
        });
        return promise;
    }


    lDB._isDesiredDatabaseOpen = function () {
        if (lDB.activeDb === undefined || lDB.activeDb === null) {
            return false;
        }
        if (lDB.activeDb.name === lDB.databaseName) {
            return true;
        }
        else {
            return false;
        }
    }

    lDB._openDatabase = function (versionNumber, versionChangeCallback) {
        var promise = new Promise((resolve, reject) => {
            if (lDB._isDesiredDatabaseOpen() && versionNumber === undefined) {
                resolve(lDB.activeDb);
            }
            else {
                if (versionChangeCallback !== undefined) {
                    // version change locks out other pending requests
                    lDB._incrementPendingVersionChange().then(() => {
                        lDB._openDbWithinMutex(resolve, reject, versionNumber, versionChangeCallback);
                    });
                }
                else {
                    // normal requests get executed in order
                    lDB._incrementPendingRequests().then(pending => {
                        if (pending <= 1) {
                            lDB._openDbWithinMutex(resolve, reject, versionNumber, versionChangeCallback)
                        }
                        else {
                            var endTime = performance.now() + lDB.timeoutMilliseconds;
                            var databaseName = lDB.databaseName;
                            lDB._checkDatabaseWithDetermination(resolve, 16, endTime, reject, databaseName, versionNumber, versionChangeCallback)
                        }
                    });
                }
            }
        });
        return promise;
    }


    // modular definition of how we send the open request because it can be done in multiple circumstances
    lDB.__createOpenRequest = function (resolveCallback, rejectCallback, versionNumber, versionChangeCallback) {
        // version number doesn't have to be defined
        // (and only is if we're creating or deleting an object store)
        // this may be undefined, and will only be called if a higher version number is requested
        if (versionChangeCallback === undefined) {
            versionChangeCallback = null;
        }

        var request = indexedDB.open(lDB.databaseName, versionNumber);
        request.onsuccess = function (event) {
            lDB.activeDb = event.target.result;
            lDB._decrementPendingRequests();
            resolveCallback(lDB.activeDb);
        };
        request.onerror = function (error) {
            lDB._decrementPendingRequests();
            rejectCallback(error);
        };
        request.onblocked = function (event) {
            lDB._decrementPendingRequests();
            reject(event);
        };
        request.onupgradeneeded = versionChangeCallback;
    }



    // avoid the problem of race conditions waiting to open the same database
    // this function should be called through a mutex lock as in above
    lDB._openDbWithinMutex = function (resolveCallback, rejectCallback, versionNumber, versionChangeCallback) {

        // open the database if we need to
        if (!lDB._isDesiredDatabaseOpen() || versionNumber !== undefined) {
            if (lDB.activeDb !== undefined) {
                // todo: wait for pending transactions? this might happen automatically
                lDB.activeDb.close();
            }
            // send the request to open, forwarding the proper callbacks
            lDB.__createOpenRequest(resolveCallback, rejectCallback, versionNumber, versionChangeCallback);
        }
        else {
            // return the open db if it's the right one (and we don't care about version number)
            // with the mutex lock this should eliminate repeat requests to open the same database
            if (lDB._isDesiredDatabaseOpen()) {
                lDB._decrementPendingRequests();
                resolveCallback(lDB.activeDb);
            }
            // otherwise we send our request and play the waiting game
            else {

                // openRequest = indexedDB.open(lDB.databaseName);
                // the resolve callback will be activated after the open request raises the onsuccess event
                var startTime = performance.now();
                var timeoutMilliseconds = lDB.openTimeoutMilliseconds;
                var endTime = startTime + timeoutMilliseconds;
                var databaseName = lDB.databaseName; //defining it here means we will keep checking for it

                lDB._checkDatabaseWithDetermination(resolveCallback, 16, endTime, rejectCallback, databaseName, versionNumber, versionChangeCallback);
                // lDB._checkDatabaseWithDetermination(256, resolveCallback, endTime, rejectCallback, databaseName);

            }
        }
    } // end function _openDbWithMutex

    lDB._checkDatabaseWithDetermination = function (resolveCallback, timeoutMilliseconds, endTime, rejectCallback, databaseName, versionNumber, versionChangeCallback) {
        // we can check for an alternate database name, but we don't have to
        if (databaseName === undefined) {
            databaseName = lDB.databaseName;
        }

        var recheck = true;

        if (lDB.activeDb !== undefined && lDB.activeDb.name === databaseName) {
            // here we're allowing greater version numbers than specified to resolve, because it's never going back down
            if (versionNumber === undefined || lDB.activeDb.version >= versionNumber) {
                recheck = false;
                lDB._decrementPendingRequests();
                resolveCallback(lDB.activeDb);
            }
        }
        if (recheck) {
            // timeout is optional
            if (endTime !== undefined) {
                if (performance.now() > endTime) {
                    rejectCallback(lDB.activeDb);
                }
            }

            lDB._pollPendingRequests().then(pending => {
                if (pending <= 1) {
                    //we incremented the pending counter to get here, so it's time to request the database to open.
                    lDB.__createOpenRequest(resolveCallback, rejectCallback, versionNumber, versionChangeCallback);
                }
                else {
                    //check back later, double the wait time
                    if (timeoutMilliseconds === undefined) {
                        timeoutMilliseconds = 16;
                    }
                    var newTimeout = timeoutMilliseconds * 2
                    setTimeout(lDB._checkDatabaseWithDetermination, newTimeout, resolveCallback, newTimeout, endTime, rejectCallback, databaseName, versionNumber);
                }
            });
        }
    }

    lDB._closeDatabase = function () {
        var promise = new Promise((resolve) => {
            if (lDB.activeDb === undefined) {
                resolve();
            }
            else {
                lDB._closingDbName = lDB.databaseName;
                lDB.activeDb.close();
                lDB.activeDb = undefined;
                lDB._numberOfActiveReaders = 0;
                lDB._numberOfPendingRequests = 0;
                resolve();
            }
        });
        return promise;
    }


    lDB.deleteDatabase = function (name) {
        var promise = new Promise((resolve, reject) => {
            if (name === undefined) {
                reject('you must supply a database name');
            }
            let found = false;
            lDB.getAllDatabasenames().then((names) => {
                for (var i = 0; i < names.length; i++) {
                    if (names[i].name === name) {
                        found = true;
                    }
                }
                if (!found) {
                    resolve('database not found, nothing deleted');
                }
                else {
                    deleteRequest = indexedDB.deleteDatabase(name);
                    deleteRequest.onblocked = (function (event) { reject(event) });
                    deleteRequest.onupgradeneeded = (function () { return }); // shouldn't happen but if it does it would be followed by another event
                    deleteRequest.onerror = (function (event) { reject(event) });
                    deleteRequest.onsuccess = (function (event) {
                        lDB.activeDb = undefined;
                        lDB.objectStore = undefined;
                        resolve(event)
                    });
                }
            });
        });
        return promise;
    }

    lDB.getAllDatabasenames = function () {
        if (lDB.activeDb !== undefined) {
            lDB.activeDb.close();
        }
        var promise = new Promise((resolve) => {
            indexedDB.databases().then((names) => { resolve(names) })
        });
        return promise;
    }

    return lDB;
})();

module.exports = lDB;