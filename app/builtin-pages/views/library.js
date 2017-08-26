/* globals Event beaker DatArchive history beakerBrowser confirm */

import * as yo from 'yo-yo'
import renderSidebar from '../com/sidebar'
import {FileTree, ArchivesList} from 'builtin-pages-lib'
import {makeSafe} from '../../lib/strings'
import {throttle} from '../../lib/functions'
import renderTabs from '../com/tabs'
import renderGraph from '../com/peer-history-graph'
import renderFiles from '../com/files-list'
import renderSearchIcon from '../icon/search'
import renderDotsIcon from '../icon/three-dots'
import renderTrashIcon from '../icon/trash'
import {niceDate} from '../../lib/time'
import prettyBytes from 'pretty-bytes'
import toggleable, {closeAllToggleables} from '../com/toggleable'
import * as toast from '../com/toast'
import * as sharePopup from '../com/share-popup'

// HACK FIX
// the good folk of whatwg didnt think to include an event for pushState(), so let's add one
// -prf
var _wr = function (type) {
  var orig = window.history[type]
  return function () {
    var rv = orig.apply(this, arguments)
    var e = new Event(type.toLowerCase())
    e.arguments = arguments
    window.dispatchEvent(e)
    return rv
  }
}
window.history.pushState = _wr('pushState')
window.history.replaceState = _wr('replaceState')

// globals
// =

var userProfileUrl
var archivesList
var trashList = []
var isTrashOpen = false
var isSidebarOpen = false
var isEditingInfo = false
var currentFilter = ''
var currentSort = 'mtime'
var currentSection = 'files'
var selectedArchiveKey = ''
var selectedArchive
var selectedArchives = []
var viewError

setup()
async function setup () {
  // load archives
  archivesList = new ArchivesList({listenNetwork: true})
  await archivesList.setup({isSaved: true})
  userProfileUrl = null//TODO (await beaker.profiles.getUserProfile()).url
  update()

  // load current archive
  await loadCurrentArchive()

  // load deleted archives
  trashList = await beaker.archives.list({isSaved: false})

  // check if sidebar should be open
  isSidebarOpen = !selectedArchive

  update()

  // render graph regularly
  setInterval(() => {
    if (selectedArchive) {
      updateGraph()
    }
  }, 5e3)

  // setup handlers
  archivesList.addEventListener('changed', update)
  beaker.archives.addEventListener('updated', onArchivesUpdated)
  beaker.archives.addEventListener('network-changed', onNetworkChanged)
  window.addEventListener('pushstate', loadCurrentArchive)
  window.addEventListener('popstate', loadCurrentArchive)
}

async function parseURLKey () {
  var path = window.location.pathname
  if (path === '/' || !path) return false
  try {
    // extract key from url
    var name = /^\/([^/]+)/.exec(path)[1]
    if (/[0-9a-f]{64}/i.test(name)) return name
    return DatArchive.resolveName(name)
  } catch (e) {
    console.error('Failed to parse URL', e)
    throw new Error('Invalid dat URL')
  }
}

async function loadCurrentArchive () {
  // reset state
  if (isTrashOpen) isTrashOpen = false
  if (selectedArchive && selectedArchive.events) {
    selectedArchive.events.close()
    selectedArchive.events = null
  }
  viewError = null

  try {
    selectedArchiveKey = await parseURLKey()
    if (selectedArchiveKey) {
      // show 'loading...'
      update()

      // load archive metadata
      var a = new DatArchive(selectedArchiveKey)
      selectedArchive = await a.getInfo()
      selectedArchive.history = []
      selectedArchive.fileTree = {rootNode: null}
      console.log(selectedArchive)

      // load the filetree from the last published
      var aLastPublish = new DatArchive(`${selectedArchiveKey}+${selectedArchive.version}`)
      var fileTree = new FileTree(aLastPublish, {onDemand: true})

      // fetch all data
      var [history] = await Promise.all([
        a.history({end: 20, reverse: true, timeout: 10e3}),
        fileTree.setup().catch(err => null)
      ])
      selectedArchive.history = history
      selectedArchive.historyPaginationOffset = 20
      selectedArchive.fileTree = fileTree
      selectedArchive.events = a.createFileActivityStream()

      // wire up events
      selectedArchive.events.addEventListener('changed', update)
    } else {
      selectedArchive = null
    }
  } catch (e) {
    selectedArchive = null
    console.error(e)
    viewError = e
  }

  update()
}

// rendering
// =

function update () {
  var isEmpty = !(isTrashOpen || selectedArchive || selectedArchiveKey)
  var viewCls = isEmpty ? 'empty' : ''

  /*
  TODO - sort control, needs to be restored? -prf
  <div class="sort">
    <select name="sort" oninput=${onChangeSort}>
      <option value="mtime" selected=${currentSort === 'mtime'}>
        Recently updated
      </option>
      <option value="alphabetical" selected=${currentSort === 'alphabetical'}>
        Name
      </option>
     <option value="peers" selected=${currentSort === 'peers'}>
        Active peers
      </option>
    </select>
  </div>
*/

  yo.update(document.querySelector('.library-wrapper'), yo`
    <div class="library-wrapper builtin-wrapper">
      ${renderSidebar('library')}
      <div class="builtin-sidebar">
        <div class="section archives-list">
          <div class="sidebar-actions">
            <label for="filter">
              ${renderSearchIcon()}
              <input
                class="filter"
                name="filter"
                placeholder="Search"
                type="text"
                value=${currentFilter || ''}
                onkeyup=${onChangeFilter}/>
              <a onclick=${onClearFilter} class="clear-filter ${currentFilter ? 'visible' : ''}">
                <i class="fa fa-close"></i>
              </a>
            </label>
          </div>

          ${isTrashOpen
            ? rTrash()
            : yo`
              <div>
              <div class="section">
                <h2>Recent</h2>
                ${rRecentArchivesList()}
              </div>

              <div class="section">
                <h2>Created by you</h2>
                ${rYourArchivesList()}
              </div>
              </div>
            `
          }
        </div>

        <div class="trash-controls">
          <button onclick=${onClickBulkDelete} class="bulk-delete btn primary ${selectedArchives.length ? 'visible' : ''}">
            <i class="fa fa-trash"></i>
          </button>
          <button class="view-trash" onclick=${onToggleTrash}>${isTrashOpen ? 'Close Trash' : 'Show Trash'}
            <i class="fa ${isTrashOpen ? 'fa-close' : 'fa-trash'}"></i>
          </button>
        </div>
      </div>

      <div class="builtin-main ${viewCls}">
        ${rView()}
      </div>
    </div>
  `)
}

function rView () {
  document.title = 'Library'
  if (viewError) return rError()
  else if (isTrashOpen) return rTrash()
  else if (selectedArchive) return rArchive(selectedArchive)
  else if (selectedArchiveKey) return 'Loading...'
  return rEmpty()
}

function rArchivesList () {
  // apply filter
  var filteredArchives = archivesList.archives.filter(archive => {
    if (!currentFilter) {
      return true
    } else if (currentFilter && archive.title && archive.title.toLowerCase().indexOf(currentFilter) !== -1) {
      return true
    }
    return false
  })

  // sort
  filteredArchives.sort((a, b) => {
    if (currentSort === 'alphabetical') return niceName(a).localeCompare(niceName(b))
    if (currentSort === 'mtime') return b.mtime - a.mtime
    if (currentSort === 'peers') return b.peers - a.peers
  })

  return filteredArchives.map(rArchiveListItem)
}

function rArchiveListItem (archiveInfo) {
  var cls = archiveInfo.key === selectedArchiveKey ? 'active' : ''
  var icon = ''

  if (archiveInfo.url === userProfileUrl) {
    icon = yo`<i class="fa fa-user"></i>`
  }

  return yo`
    <div class="nav-item archive ${cls}" onclick=${onSelectArchive(archiveInfo)}>
      <div class="title">
        ${icon}
        ${niceName(archiveInfo)}
      </div>
    </div>
  `
}

function rArchive (archiveInfo) {
  document.title = `Library - ${archiveInfo.title || 'dat://' + archiveInfo.key}`

  // set up icons and labels for save/unsave buttons
  var toggleSaveIcon, toggleSaveText
  if (archiveInfo.isOwner) {
    if (archiveInfo.userSettings.isSaved) {
      toggleSaveIcon = '' // 'fa-trash'
      toggleSaveText = 'Delete'
    } else {
      toggleSaveIcon = '' // 'fa-floppy-o'
      toggleSaveText = 'Restore'
    }
  } else {
    if (archiveInfo.userSettings.isSaved) {
      toggleSaveIcon = '' // fa-times-circle'
      toggleSaveText = 'Remove from library'
    } else {
      toggleSaveIcon = '' // fa-plus'
      toggleSaveText = 'Add to library'
    }
  }

  return yo`
    <div class="archive">
      ${rViewHeader(archiveInfo)}

      ${rNotSaved(archiveInfo)}

      <div class="nav-wrapper">
        <div class="nav">
          ${renderTabs(currentSection, [
            {id: 'files', label: 'Files', onclick: onClickTab('files')},
            {id: 'log', label: 'History', onclick: onClickTab('log')},
            {id: 'network', label: 'Network', onclick: onClickTab('network')},
            {id: 'settings', label: 'Settings', onclick: onClickTab('settings')}
          ].filter(Boolean))}

          ${toggleable(yo`
            <div class="dropdown-btn-container toggleable-container" data-toggle-id="archive-dropdown-menu">
              <span class="nav-item dropdown toggleable">
                ${renderDotsIcon()}
              </span>

              <div class="dropdown-btn-list">
                ${archiveInfo.isOwner ? yo`
                  <div class="dropdown-item" onclick=${onImportFiles}>
                    Import files
                    <span class="icon">+</span>
                  </div>
                ` : ''}
                <div class="dropdown-item" onclick=${onFork}>
                  Fork this site
                  <span class="icon">+</span>
                </div>
                <div class="dropdown-item" onclick=${onToggleSaved}>
                  ${toggleSaveText}
                  ${renderTrashIcon()}
                </div>
              </div>
            </div>
          `)}
        </div>
      </div>

      <div class="tabs-content">
        ${({
          files: () => rFiles(archiveInfo),
          log: () => rHistory(archiveInfo),
          settings: () => rSettings(archiveInfo),
          network: () => rNetwork(archiveInfo)
        })[currentSection]()}
      </div>
    </div>
  `
}

function rViewHeader (archiveInfo) {
  return yo`
    <div class="builtin-header fixed">
      <h2 class="title" title=${archiveInfo.title}>
        <a href="dat://${archiveInfo.key}">
          <span>${niceName(archiveInfo)}</span>
          <i class="fa fa-external-link"></i>
        </a>
        ${archiveInfo.isOwner ? '' : yo`<span class="readonly">Read-only</span>`}
      </h2>

      <p class="desc">${archiveInfo.description || yo`<em>No description</em>`}</p>

      <div class="actions">
        <button class="btn primary" onclick=${onShare}>
          <i class="fa fa-link"></i>
          Share
        </button>
      </div>
    </div>
  `
}

function rError () {
  return yo`
    <div class="message error">
      <i class="fa fa-exclamation-triangle"></i> ${viewError.toString()}
    </div>
  `
}

function rNotSaved (archiveInfo) {
  if (archiveInfo.userSettings.isSaved) return ''
  if (archiveInfo.isOwner && !archiveInfo.userSettings.isSaved) {
    return yo`
      <section class="message info">
        <i class="fa fa-info-circle"></i>
        <span>This archive has been deleted</span>
        <button class="btn" onclick=${onToggleSaved} title="Restore this archive">Restore</button>
      </section>
    `
  } else {
    return yo`
      <section class="message primary">
        <i class="fa fa-info-circle"></i>
        <span>This archive isn't saved to your Library</span>
        <button class="btn" onclick=${onToggleSaved} title="Save this archive to your Library">Save to Library</button>
      </section>
    `
  }

}

function rNetwork (archiveInfo) {
  const isSaved = archiveInfo.userSettings.isSaved
  const isChecked = {
    networked: archiveInfo.userSettings.networked,
    autoDownload: isSaved && archiveInfo.userSettings.autoDownload,
    autoUpload: isSaved && archiveInfo.userSettings.autoDownload
  }
  const debugLink = 'beaker://swarm-debugger/' + selectedArchive.url.slice('dat://'.length)

  let networkSettingsEls
  if (archiveInfo.isOwner) {
    networkSettingsEls = [
      yo`
        <div class="sharing-settings ${!isSaved ? 'disabled' : ''}">
          <h3>Network Sharing</h3>
          <fieldset>
            <label onclick=${(e) => onSetNetworked(e, true)}>
              <input type="radio" name="networked_setting" disabled=${!isSaved} checked=${isChecked.networked} />
              Share these files on the network
            </label>
            <label onclick=${(e) => onSetNetworked(e, false)}>
              <input type="radio" name="networked_setting" disabled=${!isSaved} checked=${!isChecked.networked} />
              Offline
            </label>
          </fieldset>
        </div>
      `
    ]
  } else {
    networkSettingsEls = [
      isSaved
        ? ''
        : yo`
            <p><a onclick=${onToggleSaved} class="link">Add this site to your library</a> to configure the download settings.</p>
          `,
      yo`
        <div class="setting ${!isSaved ? 'disabled' : ''}">
          <h5>Download files</h5>
          <fieldset>
            <label onclick=${(e) => onSetAutoDownload(e, false)}>
              <input type="radio" name="download_setting" disabled=${!isSaved} checked=${!isChecked.autoDownload} />
              When I visit
            </label>
            <label onclick=${(e) => onSetAutoDownload(e, true)}>
              <input type="radio" name="download_setting" disabled=${!isSaved} checked=${isChecked.autoDownload} />
              Always <span class="muted">(Sync for offline use)</span>
            </label>
          </fieldset>
        </div>
      `
    ]
  }

  return yo`
    <div class="network">
      ${networkSettingsEls}

      <h3>Network activity</h3>
      ${renderGraph(archiveInfo)}
      <a href=${debugLink} title="Open network debugger">
        <i class="fa fa-bug"></i>
        Network debugger
      </a>
    </div>
  `
}

function rFiles (archiveInfo) {
  return yo`
    <div class="published-files">
      ${renderFiles(archiveInfo)}
    </div>
  `
}

function rHistory (archiveInfo) {
  var rows = archiveInfo.history.map(function (item, i) {
    var rev = item.version
    var revType = makeSafe(item.type)
    var urlRev = (revType === 'put') ? rev : (rev - 1) // give the one revision prior for deletions
    revType = revType === 'put' ? 'added' : 'deleted'

    return `
      <div class="history-item">
        <div class="date">
          <a class="link" href=${`dat://${archiveInfo.key}+${rev}`} target="_blank">
          Revision ${rev}</a>
        </div>
        ${revType}
        <a class="path" href="${`dat://${archiveInfo.key}+${urlRev}${item.path}`}" target="_blank">
          ${makeSafe(item.path.slice(1))}
        </a>
      </div>
    `
  })

  if (rows.length === 0) {
    rows.push(`<em>Nothing has been published yet.</em>`)
  }

  var loadMoreBtn = ''
  if (archiveInfo.version > archiveInfo.historyPaginationOffset) {
    loadMoreBtn = yo`<div>
      <a class="load-more" href="#" onclick=${onLoadMoreHistory}>
        Load more
        <i class="fa fa-caret-down"></i>
      </a>
    </div>`
  }

  // use innerHTML instead of yo to speed up this render
  var rowEls = yo`<div></div>`
  rowEls.innerHTML = rows.join('')
  return yo`<div class="history">${rowEls}${loadMoreBtn}</div>`
}

function rSettings (archiveInfo) {
  const isSaved = archiveInfo.userSettings.isSaved

  // editable title and description
  var titleEl, descEl
  if (archiveInfo.isOwner && isEditingInfo) {
    titleEl = yo`
      <td>
        <input id="title" onkeyup=${settingsOnKeyup} value=${niceName(archiveInfo)} type="text"/>
      </td>
    `
    descEl = yo`
      <td>
        <input id="desc" onkeyup=${settingsOnKeyup} value=${archiveInfo.description || ''} type="text"/>
      </td>
    `
  } else if (archiveInfo.isOwner) {
    titleEl = yo`
      <td>
        ${niceName(archiveInfo)}
        <i onclick=${onClickEdit} class="fa fa-pencil"></i>
      </td>`
    descEl = yo`
      <td>
        ${niceDesc(archiveInfo)}
        <i onclick=${onClickEdit} class="fa fa-pencil"></i>
      </td>`
  } else {
    titleEl = yo`<td>${niceName(archiveInfo)}</td>`
    descEl = yo`<td>${niceDesc(archiveInfo)}</td>`
  }

  // tools that differ if owner
  var toolsEls
  if (!archiveInfo.isOwner) {
    toolsEls = yo`
      <div class="tools">
        <a class="link" onclick=${onDeleteDownloadedFiles}><i class="fa fa-trash"></i> Delete downloaded files</a>
      </div>
    `
  }

  // render
  return yo`
    <div class="settings">
      <table>
        <tr><td class="label">Title</td>${titleEl}</tr>
        <tr><td class="label">Description</td>${descEl}</tr>
        <tr><td class="label">Size</td><td>${prettyBytes(archiveInfo.size)}</td></tr>
        <tr><td class="label">Updated</td><td>${niceDate(archiveInfo.mtime || 0)}</td></tr>
        <tr><td class="label">Editable</td><td>${archiveInfo.isOwner}</td></tr>
      </table>
      ${archiveInfo.isOwner && isEditingInfo ? yo`<button onclick=${onSaveSettings} class="save btn">Apply changes</button>` : ''}
      ${toolsEls}
    </div>
  `
}

function rTrash () {
  return yo`
    <div class="section trash">
      <h2>Trash</h2>
      ${trashList.length ? '' : yo`<p>No items in trash</p>`}

      <div class="trash-list">
        ${trashList.map(archiveInfo => yo`
          <div class="nav-item archive" onclick=${onSelectArchive(archiveInfo)}>
            <div class="title">${niceName(archiveInfo)}</div>
            <button class="btn restore" onclick=${e => onUndelete(e, archiveInfo.key)}>
              Restore
            </button>
          </div>`
        )}
      </div>
    </div>
  `
}

function rEmpty () {
  return yo`
    <div class="empty">
      <i class="fa fa-folder-open-o"></i>
    </div>
  `
}

function updateGraph () {
  if (currentSection === 'network') {
    var el = document.querySelector(`#history-${selectedArchive.key}`)
    yo.update(el, renderGraph(selectedArchive))
  }
}

// event handlers
// =

function onArchivesUpdated (e) {
  if (selectedArchive && e.details.url === selectedArchive.url) {
    loadCurrentArchive()
  }
}

function onNetworkChanged (e) {
  if (selectedArchive && e.details.url === selectedArchive.url) {
    var now = Date.now()
    var lastHistory = selectedArchive.peerHistory.slice(-1)[0]
    if (lastHistory && (now - lastHistory.ts) < 10e3) {
      // if the last datapoint was < 10s ago, just update it
      lastHistory.peers = e.details.peerCount
    } else {
      selectedArchive.peerHistory.push({ts: now, peers: e.details.peerCount})
    }
    updateGraph()
  }
}

function onShare (e) {
  sharePopup.create(selectedArchive.url)
}

async function onFork (e) {
  e.preventDefault()
  update()
  var a = await DatArchive.fork(selectedArchive.url, {prompt: true})
  history.pushState({}, null, 'beaker://library/' + a.url.slice('dat://'.length))
}

async function onImportFiles (e, archiveInfo) {
  var files = await beakerBrowser.showOpenDialog({
    title: 'Import files to this archive',
    buttonLabel: 'Import',
    properties: ['openFile', 'openDirectory', 'multiSelections', 'createDirectory']
  })
  if (files) {
    files.forEach(src => DatArchive.importFromFilesystem({
      src,
      dst: archiveInfo.url,
      ignore: ['dat.json'],
      inplaceImport: true
    }))
    update()
  }
}

function onClickEdit () {
  isEditingInfo = true
  update()
}

async function onSaveSettings () {
  var newTitle = document.querySelector('input#title').value
  var newDesc = document.querySelector('input#desc').value

  // update
  await beaker.archives.update(selectedArchive.url, {title: newTitle, description: newDesc})

  // exit edit-mode
  isEditingInfo = false
  update()
}

async function settingsOnKeyup (e) {
  if (e.keyCode == 13) {
    // enter-key
    onSaveSettings()
  } else if (e.keyCode == 27) {
    // escape-key
    isEditingInfo = false
    update()
  }
}

function onViewSource () {
  window.location = 'beaker://view-source/' + selectedArchive.url.slice('dat://'.length)
}

async function onToggleSaved (e) {
  e.preventDefault()
  if (selectedArchive.userSettings.isSaved) {
    selectedArchive.userSettings = await beaker.archives.remove(selectedArchive.key)
    if (selectedArchive.userSettings.isSaved == false) {
      trashList.unshift(selectedArchive)
    }
  } else {
    selectedArchive.userSettings = await beaker.archives.add(selectedArchive.key)
    await beaker.archives.restore(selectedArchive.key)
    if (selectedArchive.userSettings.isSaved == true) {
      trashList.splice(trashList.findIndex(a => a.key === selectedArchive.key), 1)
    }
  }
  closeAllToggleables()
  loadCurrentArchive()
}

async function onUndelete (e, key) {
  e.preventDefault()
  trashList.splice(trashList.findIndex(a => a.key === key), 1)
  await beaker.archives.add(key)
  await beaker.archives.restore(key)
  loadCurrentArchive()
}

async function onSetNetworked (e, value) {
  if (selectedArchive.userSettings.networked === value) {
    return
  }
  selectedArchive.userSettings.networked = value
  await beaker.archives.update(selectedArchive.key, null, {networked: value})
  await archivesList.setup({isSaved: true}) // reload listing
  update()
  toast.create('Settings updated')
}

async function onSetAutoDownload (e, value) {
  if (selectedArchive.userSettings.autoDownload === value) {
    return
  }
  selectedArchive.userSettings.autoDownload = value
  await beaker.archives.update(selectedArchive.key, null, {autoDownload: value})
  update()
  toast.create('Settings updated')
}

async function onDeleteDownloadedFiles () {
  if (!confirm('Delete downloaded files? You will be able to redownload them from the p2p network.')) {
    return false
  }
  await beaker.archives.clearFileCache(selectedArchive.key)
  toast.create('All downloaded files have been deleted')
  loadCurrentArchive()
}

function onToggleTrash () {
  isTrashOpen = !isTrashOpen
  update()
}

function onSelectArchive (archiveInfo) {
  return e => {
    history.pushState({}, null, 'beaker://library/' + archiveInfo.key)
  }
}

function onClickTab (tab) {
  return e => {
    e.preventDefault()
    currentSection = tab
    update()
  }
}

async function onLoadMoreHistory (e) {
  e.preventDefault()

  // read more history
  var a = new DatArchive(selectedArchiveKey)
  var moreHistory = await a.history({
    start: selectedArchive.historyPaginationOffset,
    end: selectedArchive.historyPaginationOffset + 500,
    reverse: true
  })

  // add to tracked history and update
  selectedArchive.history = selectedArchive.history.concat(moreHistory)
  selectedArchive.historyPaginationOffset += 500
  update()
}

function onChangeFilter (e) {
  if (e.keyCode === 27) onClearFilter()
  currentFilter = e.target.value
  update()
}

// function onChangeSort (e) {
//   var selectedIndex = e.target.selectedIndex
//   currentSort = e.target[selectedIndex].value
//   update()
// }

function onClearFilter () {
  currentFilter = ''
  document.querySelector('input[name="filter"]').value = ''
  update()
}

async function onClickBulkDelete () {
  var resultingSettings = await beaker.archives.bulkRemove(selectedArchives)
  selectedArchives.forEach(async (key, i) => {
    var settings = resultingSettings[i]
    if (!settings.isSaved) {
      trashList.unshift(await (new DatArchive(key)).getInfo())
    }
  })

  selectedArchives = []
  update()
}

// helpers
// =

function niceName (archiveInfo) {
  return (archiveInfo.title || '').trim() || 'Untitled'
}

function niceDesc (archiveInfo) {
  return (archiveInfo.description || '').trim() || yo`<em>No description</em>`
}
