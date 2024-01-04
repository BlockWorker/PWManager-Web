const DEFAULT_SYMBOLS = " !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const EXPECTED_SYNC_VERSION = 1;

const cs = crypto.subtle;

var pwm_storage = undefined;
var pwm_persistentStorage = false;
var pwm_settingItems = {};
var pwm_syncSettings = { "host": "", "port": 0, "token": "", "last_sync": new Date(0) };
var pwm_syncInProgress = false;
var pwm_lastSyncSucceeded = true;

String.prototype.insert = function(index, string) {
  if (index > 0) {
    return this.substring(0, index) + string + this.substr(index);
  }

  return string + this;
};

function genPass(master, ident, iter, longpw, symbols, callback) {
  const base = master + ident + iter;
  cs.digest("SHA-384", new TextEncoder().encode(base)).then(rawhash => {
    const hash = new Uint8Array(rawhash);
    const nhash = new Uint8Array(hash);
    if (longpw) nhash[47] %= 3;
    var pwhash;
    cs.digest("SHA-1", nhash).then(rawdhash => {
      const dhash = new Uint8Array(rawdhash);
      if (longpw) {
        pwhash = new Uint8Array(12);
        const hashoffset = (dhash[19] % 4) * 12;
        for (let i = 0; i < 12; i++) {
          pwhash[i] = hash[hashoffset + i];
        }
      } else {
        pwhash = new Uint8Array(6);
        const hashoffset = (dhash[19] % 8) * 6;
        for (let i = 0; i < 6; i++) {
          pwhash[i] = hash[hashoffset + i];
        }
      }
      var pw = btoa(String.fromCharCode.apply(String, pwhash));
      const numsymbols = longpw ? 8 : 4;
      const numchars = longpw ? 16 : 8;
      for (let i = 0; i < numsymbols; i++) {
        const place = dhash[2 * i] % (numchars + i);
        const symbol = symbols[dhash[2 * i + 1] % symbols.length];
        pw = pw.insert(place, symbol);
      }
      callback(pw);
    });
  });
}

//is the given type of persistent storage available/usable? (localStorage, sessionStorage)
function storageAvailable(type) {
  let storage;
  try {
    storage = window[type];
    const x = "__storage_test__";
    storage.setItem(x, x);
    storage.removeItem(x);
    return true;
  } catch (e) {
    return (
      e instanceof DOMException &&
      // everything except Firefox
      (e.code === 22 ||
        // Firefox
        e.code === 1014 ||
        // test name field too, because code might not be present
        // everything except Firefox
        e.name === "QuotaExceededError" ||
        // Firefox
        e.name === "NS_ERROR_DOM_QUOTA_REACHED") &&
      // acknowledge QuotaExceededError only if there's something already stored
      storage &&
      storage.length !== 0
    );
  }
}

function initStorage() {
  if (storageAvailable("localStorage")) {
    pwm_storage = window.localStorage;
    pwm_persistentStorage = true;
  } else if (storageAvailable("sessionStorage")) {
    pwm_storage = window.sessionStorage;
    pwm_persistentStorage = false;
  } else {
    pwm_storage = undefined;
    pwm_persistentStorage = false;
  }
}

function jsonReviver(key, value) {
  if (key.includes("time") || key.includes("last")) {
    return new Date(Date.parse(value));
  }
  return value;
}

function syncResponseValid(syncRes) {
  return syncRes && "uuid" in syncRes && "token" in syncRes && "sync_time" in syncRes &&
          "changed_idents" in syncRes && "deleted_idents" in syncRes && syncRes.uuid &&
          typeof syncRes.uuid === "string" && syncRes.token === pwm_syncSettings.token &&
          syncRes.sync_time && syncRes.sync_time instanceof Date &&
          !isNaN(syncRes.sync_time) && Array.isArray(syncRes.changed_idents) &&
          Array.isArray(syncRes.deleted_idents);
}

function identItemValid(item) {
  return item && "ident" in item && "iter" in item && "symbols" in item &&
          "longpw" in item && "timestamp" in item && item.ident &&
          typeof item.ident === "string" && typeof item.iter === "number" &&
          item.iter >= 0 && item.symbols && typeof item.symbols === "string" &&
          typeof item.longpw === "boolean" && item.timestamp &&
          item.timestamp instanceof Date && !isNaN(item.timestamp);
}

function syncSettingsValid(settings) {
  return settings && "host" in settings && "port" in settings && "token" in settings &&
          "last_sync" in settings && typeof settings.host === "string" &&
          typeof settings.port === "number" && typeof settings.token === "string" &&
          settings.last_sync && settings.last_sync instanceof Date && !isNaN(settings.last_sync);
}

function loadSettings() {
  pwm_settingItems = {};
  pwm_syncSettings = { "host": "", "port": 0, "token": "", "last_sync": new Date(0) };
  
  if (!pwm_storage) return;
  
  try {
    var stored = pwm_storage.getItem("pwm-settings") ?? "[]";
    var list = JSON.parse(stored, jsonReviver);
    
    if (Array.isArray(list)) {
      for (var item of list) {
        if (!identItemValid(item)) {
          console.error("Load encountered invalid ident item");
          console.error(item);
          continue;
        }
        
        pwm_settingItems[item.ident] = item;
      }
    } else {
      console.error("Load encountered invalid ident list");
      console.error(list);
    }
  } catch (e) {
    console.error("Load error while loading idents");
    console.error(e);
  }
  
  try {
    var sync_stored = pwm_storage.getItem("pwm-sync");
    if (!sync_stored) return;
    
    var syncSet = JSON.parse(sync_stored, jsonReviver);
    if (syncSettingsValid(syncSet)) {
      pwm_syncSettings = syncSet;
    } else {
      console.error("Load encountered invalid sync settings");
      console.error(syncSet);
    }
  } catch (e) {
    console.error("Load error while loading sync config");
    console.error(e);
  }
}

function syncValid() {
  if (!pwm_storage) return false;
  
  return syncSettingsValid(pwm_syncSettings) && pwm_syncSettings.host &&
          pwm_syncSettings.port > 0 && pwm_syncSettings.token;
}

function testSync(host, port, resultCb) {
  if (!host || port < 1) {
    resultCb(false);
    return;
  }
  
  try {
    var req = new XMLHttpRequest();
    
    req.addEventListener("loadend", function() {
      if (req.status != 200) {
        resultCb(false);
        return;
      }
      
      try {
        var res = JSON.parse(req.responseText);
        
        if (res && "pwm_sync_version" in res) {
          resultCb(res.pwm_sync_version === EXPECTED_SYNC_VERSION);
        } else {
          resultCb(false);
        }
      } catch (e) {
        console.error(e);
        resultCb(false);
      }
    });
    
    req.open("GET", `https://${host}:${port}/ping`);
    req.timeout = 5000;
    req.send();
  } catch (e) {
    console.error(e);
    resultCb(false);
  }
}

function sync(resultCb) {
  if (pwm_syncInProgress || !syncValid()) {
    if (resultCb) resultCb(false);
    return;
  }
  
  pwm_syncInProgress = true;
  
  try {
    testSync(pwm_syncSettings.host, pwm_syncSettings.port, function(testRes) {
      if (!testRes) {
        pwm_lastSyncSucceeded = false;
        pwm_syncInProgress = false;
        if (resultCb) resultCb(false);
        return;
      }
      
      try {
        var request = {
          "token": pwm_syncSettings.token,
          "last_sync": pwm_syncSettings.last_sync,
          "include_apps": false,
          "idents": Object.values(pwm_settingItems),
          "apps": []
        };
        
        var syncReq = new XMLHttpRequest();
        
        syncReq.addEventListener("loadend", function() {
          if (syncReq.status != 200) {
            console.error(`Sync fail: Response code ${syncReq.status} type ${syncReq.responseType}`);
            pwm_lastSyncSucceeded = false;
            pwm_syncInProgress = false;
            if (resultCb) resultCb(false);
            return;
          }
          
          try {
            var syncRes = JSON.parse(syncReq.responseText, jsonReviver);
            
            if (!syncResponseValid(syncRes)) {
              pwm_lastSyncSucceeded = false;
              pwm_syncInProgress = false;
              if (resultCb) resultCb(false);
              return;
            }
            
            var confirmation = {
              "uuid": syncRes.uuid,
              "token": syncRes.token,
              "sync_time": syncRes.sync_time
            };
            
            var confReq = new XMLHttpRequest();
            
            confReq.addEventListener("loadend", function() {
              if (confReq.status != 200) {
                console.error(`Sync confirm fail: Response code ${confReq.status}`);
                pwm_lastSyncSucceeded = false;
                pwm_syncInProgress = false;
                if (resultCb) resultCb(false);
                return;
              }
              
              try {
                for (let ident of syncRes.deleted_idents) {
                  if (!(ident && typeof ident === "string")) {
                    console.error("Sync received invalid ident deletion");
                    console.error(ident);
                    continue;
                  }
                  
                  delete pwm_settingItems[ident];
                }
                
                for (let item of syncRes.changed_idents) {
                  if (!identItemValid(item)) {
                    console.error("Sync received invalid ident entry");
                    console.error(item);
                    continue;
                  }
                  
                  pwm_settingItems[item.ident] = item;
                }
                
                pwm_storage.setItem("pwm-settings", JSON.stringify(Object.values(pwm_settingItems)));
                
                pwm_syncSettings.last_sync = syncRes.sync_time;
                pwm_storage.setItem("pwm-sync", JSON.stringify(pwm_syncSettings));
                
                pwm_lastSyncSucceeded = true;
                pwm_syncInProgress = false;
                if (resultCb) resultCb(true);
              } catch (e) {
                console.error(e);
                pwm_lastSyncSucceeded = false;
                pwm_syncInProgress = false;
                if (resultCb) resultCb(false);
              }
            });
            
            confReq.open("POST", `https://${pwm_syncSettings.host}:${pwm_syncSettings.port}/confirm`);
            confReq.setRequestHeader("Content-Type", "application/json; charset=utf-8");
            confReq.send(JSON.stringify(confirmation));
          } catch (e) {
            console.error(e);
            pwm_lastSyncSucceeded = false;
            pwm_syncInProgress = false;
            if (resultCb) resultCb(false);
          }
        });
        
        syncReq.open("POST", `https://${pwm_syncSettings.host}:${pwm_syncSettings.port}/sync`);
        syncReq.setRequestHeader("Content-Type", "application/json; charset=utf-8");
        syncReq.send(JSON.stringify(request));
      } catch (e) {
        console.error(e);
        pwm_lastSyncSucceeded = false;
        pwm_syncInProgress = false;
        if (resultCb) resultCb(false);
      }
    });
  } catch (e) {
    console.error(e);
    pwm_lastSyncSucceeded = false;
    pwm_syncInProgress = false;
    if (resultCb) resultCb(false);
  }
}
