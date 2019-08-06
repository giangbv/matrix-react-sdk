/*
Copyright 2015 OpenMarket Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

'use strict';

const React = require('react');
import PropTypes from 'prop-types';
const sdk = require('../../../index');

module.exports = React.createClass({
    displayName: 'LocalSearchResult',

    propTypes: {
        // a matrix-js-sdk SearchResult containing the details of this result
        searchResult: PropTypes.array.isRequired,

        // a list of strings to be highlighted in the results
        // searchHighlights: PropTypes.array,

        // href for the highlights in this result
        // resultLink: PropTypes.string,

        onHeightChanged: PropTypes.func
    },

    render: function() {
        // const DateSeparator = sdk.getComponent('messages.DateSeparator');
        const EventTile = sdk.getComponent('rooms.EventTile');
        const result = this.props.searchResult;
        const DateSeparator = sdk.getComponent('messages.DateSeparator');
        // const mxEv = result.context.getEvent();
        const ret = [];

        // const timeline = result.context.getTimeline();
        for (let j = 0; j < result.length; j++) {
            const ev = result[j];
            // var highlights;
            // const contextual = j != result.context.getOurEventIndex();
            // if (!contextual) {
            //     highlights = this.props.searchHighlights;
            // }

            const ts = ev.event.origin_server_ts;
            ret.push([<DateSeparator key={ts + '-search'} ts={ts} />]);
            // if (EventTile.haveTileForEvent(ev)) {
            const resultLink = '#/room/' + ev.event.room_id + '/' + ev.getId();
            ret.push(
                <EventTile
                    key={'id-' + '+' + j}
                    mxEvent={ev}
                    // highlights={highlights}
                    permalinkCreator={this.props.permalinkCreator}
                    highlightLink={resultLink}
                    onHeightChanged={this.props.onHeightChanged}
                />
            );
            // }
        }
        return <div>{ret}</div>;
    }
});
