// Auto-generated from captured entitiesV2 request bodies. Date bounds (lte/gte)
// are freshened at runtime in background.js so the trip window stays current.
self.RLB_PAYLOADS = {
  inTransit: {
    "filter": [
        {
            "query": [
                {
                    "field": "dynamicSearchFields.visibilityStatus",
                    "operation": 1,
                    "type": 1,
                    "value": [
                        "DRAFT"
                    ]
                },
                {
                    "field": "dynamicSearchFields.keywords",
                    "operation": 1,
                    "type": 1,
                    "value": [
                        "IGNORE_FOR_TRIP"
                    ]
                },
                {
                    "field": "effectiveStart",
                    "operation": 0,
                    "type": 3,
                    "lte": "2026-12-14T00:00:00.000Z"
                },
                {
                    "field": "effectiveEnd",
                    "operation": 0,
                    "type": 3,
                    "gte": "2026-05-31T00:00:00.000Z"
                },
                {
                    "field": "dynamicSearchFields.visibilityStatus",
                    "operation": 0,
                    "type": 0
                },
                {
                    "field": "dynamicSearchFields.visibilityStatus",
                    "operation": 0,
                    "type": 1,
                    "value": [
                        "IN-TRANSIT"
                    ]
                }
            ],
            "modules": [
                {
                    "moduleType": "trip",
                    "viewTypes": [
                        "tour",
                        "tourTerminal"
                    ]
                }
            ],
            "loadTypeFilters": [
                "All"
            ]
        },
        {
            "query": [
                {
                    "field": "dynamicSearchFields.visibilityStatus",
                    "operation": 1,
                    "type": 1,
                    "value": [
                        "DRAFT"
                    ]
                },
                {
                    "field": "dynamicSearchFields.keywords",
                    "operation": 1,
                    "type": 1,
                    "value": [
                        "IGNORE_FOR_TRIP"
                    ]
                },
                {
                    "field": "effectiveStart",
                    "operation": 0,
                    "type": 3,
                    "lte": "2026-12-14T00:00:00.000Z"
                },
                {
                    "field": "effectiveEnd",
                    "operation": 0,
                    "type": 3,
                    "gte": "2026-05-31T00:00:00.000Z"
                },
                {
                    "field": "dynamicSearchFields.visibilityStatus",
                    "operation": 0,
                    "type": 0
                },
                {
                    "field": "dynamicSearchFields.visibilityStatus",
                    "operation": 0,
                    "type": 1,
                    "value": [
                        "COMPLETED"
                    ]
                },
                {
                    "field": "dynamicSearchFields.blockEffectiveEnd",
                    "operation": 0,
                    "type": 3,
                    "gte": "2026-06-18T18:49:59.733Z"
                }
            ],
            "modules": [
                {
                    "moduleType": "trip",
                    "viewTypes": [
                        "tour",
                        "tourTerminal"
                    ]
                }
            ],
            "loadTypeFilters": [
                "All"
            ]
        },
        {
            "query": [
                {
                    "field": "dynamicSearchFields.visibilityStatus",
                    "operation": 1,
                    "type": 1,
                    "value": [
                        "DRAFT"
                    ]
                },
                {
                    "field": "dynamicSearchFields.keywords",
                    "operation": 1,
                    "type": 1,
                    "value": [
                        "IGNORE_FOR_TRIP"
                    ]
                },
                {
                    "field": "dynamicSearchFields.isAdhocLoad",
                    "operation": 0,
                    "type": 1,
                    "value": [
                        "true"
                    ]
                },
                {
                    "field": "effectiveStart",
                    "operation": 0,
                    "type": 3,
                    "lte": "2026-12-14T00:00:00.000Z"
                },
                {
                    "field": "effectiveEnd",
                    "operation": 0,
                    "type": 3,
                    "gte": "2026-05-31T00:00:00.000Z"
                },
                {
                    "field": "dynamicSearchFields.visibilityStatus",
                    "operation": 0,
                    "type": 0
                },
                {
                    "field": "dynamicSearchFields.visibilityStatus",
                    "operation": 0,
                    "type": 1,
                    "value": [
                        "IN-TRANSIT"
                    ]
                }
            ],
            "modules": [
                {
                    "moduleType": "trip",
                    "viewTypes": [
                        "vehicleRun",
                        "vehicleRunTerminal"
                    ]
                }
            ],
            "loadTypeFilters": [
                "All"
            ]
        }
    ],
    "sort": [
        {
            "field": "dynamicSortFields.isRetendered",
            "direction": 1,
            "type": 0
        },
        {
            "field": "dynamicSortFields.unaccepted",
            "direction": 1,
            "type": 0
        },
        {
            "field": "dynamicSortFields.startTime",
            "direction": 0,
            "type": 0
        },
        {
            "field": "dynamicSortFields.startTime",
            "direction": 0,
            "type": 0
        }
    ],
    "pagination": {
        "size": 100,
        "from": 0
    }
},
  upcoming: {
    "filter": [
        {
            "query": [
                {
                    "field": "dynamicSearchFields.visibilityStatus",
                    "operation": 1,
                    "type": 1,
                    "value": [
                        "DRAFT"
                    ]
                },
                {
                    "field": "dynamicSearchFields.keywords",
                    "operation": 1,
                    "type": 1,
                    "value": [
                        "IGNORE_FOR_TRIP"
                    ]
                },
                {
                    "field": "effectiveStart",
                    "operation": 0,
                    "type": 3,
                    "lte": "2026-12-14T00:00:00.000Z"
                },
                {
                    "field": "effectiveEnd",
                    "operation": 0,
                    "type": 3,
                    "gte": "2026-05-31T00:00:00.000Z"
                },
                {
                    "field": "dynamicSearchFields.visibilityStatus",
                    "operation": 0,
                    "type": 0
                },
                {
                    "field": "dynamicSearchFields.visibilityStatus",
                    "operation": 0,
                    "type": 1,
                    "value": [
                        "UPCOMING",
                        "ASSIGNED",
                        "UNUSED_BLOCK"
                    ]
                }
            ],
            "modules": [
                {
                    "moduleType": "trip",
                    "viewTypes": [
                        "tour",
                        "tourTerminal"
                    ]
                }
            ],
            "loadTypeFilters": [
                "All"
            ]
        },
        {
            "query": [
                {
                    "field": "dynamicSearchFields.visibilityStatus",
                    "operation": 1,
                    "type": 1,
                    "value": [
                        "DRAFT"
                    ]
                },
                {
                    "field": "dynamicSearchFields.keywords",
                    "operation": 1,
                    "type": 1,
                    "value": [
                        "IGNORE_FOR_TRIP"
                    ]
                },
                {
                    "field": "dynamicSearchFields.isAdhocLoad",
                    "operation": 0,
                    "type": 1,
                    "value": [
                        "true"
                    ]
                },
                {
                    "field": "effectiveStart",
                    "operation": 0,
                    "type": 3,
                    "lte": "2026-12-14T00:00:00.000Z"
                },
                {
                    "field": "effectiveEnd",
                    "operation": 0,
                    "type": 3,
                    "gte": "2026-05-31T00:00:00.000Z"
                },
                {
                    "field": "dynamicSearchFields.visibilityStatus",
                    "operation": 0,
                    "type": 0
                },
                {
                    "field": "dynamicSearchFields.visibilityStatus",
                    "operation": 0,
                    "type": 1,
                    "value": [
                        "UPCOMING",
                        "ASSIGNED",
                        "UNUSED_BLOCK"
                    ]
                }
            ],
            "modules": [
                {
                    "moduleType": "trip",
                    "viewTypes": [
                        "vehicleRun",
                        "vehicleRunTerminal"
                    ]
                }
            ],
            "loadTypeFilters": [
                "All"
            ]
        },
        {
            "query": [
                {
                    "field": "dynamicSearchFields.visibilityStatus",
                    "operation": 0,
                    "type": 0
                },
                {
                    "field": "dynamicSearchFields.hasTour",
                    "operation": 0,
                    "type": 1,
                    "value": [
                        "false"
                    ]
                },
                {
                    "field": "effectiveEnd",
                    "operation": 0,
                    "type": 3,
                    "gte": "2026-05-31T00:00:00.000Z"
                },
                {
                    "field": "effectiveStart",
                    "operation": 0,
                    "type": 3,
                    "lte": "2026-12-14T00:00:00.000Z"
                },
                {
                    "field": "dynamicSearchFields.visibilityStatus",
                    "operation": 0,
                    "type": 1,
                    "value": [
                        "UPCOMING",
                        "ASSIGNED",
                        "UNUSED_BLOCK"
                    ]
                },
                {
                    "field": "dynamicSearchFields.visibilityStatus",
                    "operation": 1,
                    "type": 1,
                    "value": [
                        "DRAFT"
                    ]
                },
                {
                    "field": "dynamicSearchFields.keywords",
                    "operation": 1,
                    "type": 1,
                    "value": [
                        "IGNORE_FOR_TRIP"
                    ]
                },
                {
                    "field": "effectiveEnd",
                    "operation": 0,
                    "type": 3,
                    "gte": "2026-06-18T18:49:59.733Z"
                }
            ],
            "modules": [
                {
                    "moduleType": "capacity",
                    "viewTypes": [
                        "block"
                    ]
                }
            ]
        }
    ],
    "sort": [
        {
            "field": "dynamicSortFields.isRetendered",
            "direction": 1,
            "type": 0
        },
        {
            "field": "dynamicSortFields.unaccepted",
            "direction": 1,
            "type": 0
        },
        {
            "field": "dynamicSortFields.startTime",
            "direction": 0,
            "type": 0
        },
        {
            "field": "dynamicSortFields.startTime",
            "direction": 0,
            "type": 0
        }
    ],
    "pagination": {
        "size": 100,
        "from": 0
    }
}
};
